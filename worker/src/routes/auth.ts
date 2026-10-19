/** Auth routes (port of backend/src/routes/auth.js + google.js + apple.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { providersConfigured } from '../config';
import { verifyOidcToken, signEs256 } from '../crypto';
import { randomToken } from '../util';
import { issueSession, clearSession, upsertUser, currentUser, makeState, checkState, clearState } from '../session';
import { parseCookies, setCookie, clearCookie } from '../cookies';
import { json, rateLimit } from '../http';

const app = new Hono<AppEnv>();

const STATE_COOKIE = 'st_oauth';

/** OAuth state + nonce round-trip in one short-lived cookie: "<state>.<nonce>". */
function startAuth(c: any): { state: string; nonce: string } {
  const state = randomToken(20);
  const nonce = randomToken(16);
  setCookie(c, STATE_COOKIE, `${state}.${nonce}`, { maxAge: 600 });
  return { state, nonce };
}

function readStateNonce(c: any, state: unknown): { nonce: string } | null {
  const raw = parseCookies(c)[STATE_COOKIE];
  if (!raw || !state) return null;
  const [st, nonce] = raw.split('.');
  if (st !== state) return null;
  return { nonce };
}

function finishLogin(c: any, user: { id: string }): Response {
  issueSession(c, c.env, user.id);
  clearCookie(c, STATE_COOKIE);
  return c.redirect('/dashboard?login=success');
}

function failLogin(c: any, message: string): Response {
  clearCookie(c, STATE_COOKIE);
  return c.redirect(`/login?error=${encodeURIComponent(message)}`);
}

const loginLimiter = rateLimit({ windowMs: 60_000, max: 30 });

/* ---------------- Google ---------------- */

function googleAuthorizeUrl(c: any, { state, nonce }: { state: string; nonce: string }): string {
  const env = c.env as Env;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${c.get('config').publicBaseUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

app.get('/google', loginLimiter, (c) => {
  const cfg = c.get('config');
  if (!providersConfigured(cfg).google) return failLogin(c, 'Google sign-in is not configured on this server.');
  const { state, nonce } = startAuth(c);
  return c.redirect(googleAuthorizeUrl(c, { state, nonce }));
});

async function googleCallback(c: any): Promise<Response> {
  const env = c.env as Env;
  const cfg = c.get('config');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const sn = readStateNonce(c, state || '');
  if (!code || !sn) return failLogin(c, 'Invalid or expired sign-in state. Please try again.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: env.GOOGLE_CLIENT_ID || '',
        client_secret: env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: `${cfg.publicBaseUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`);
    const tokens = (await tokenRes.json()) as { id_token?: string };
    const claims = await verifyOidcToken(tokens.id_token || '', {
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID || '',
      nonce: sn.nonce,
    });
    const identity = {
      provider: 'google',
      sub: claims.sub,
      email: claims.email,
      name: claims.name || claims.email?.split('@')[0] || 'Store owner',
      avatarUrl: claims.picture || '',
    };
    return finishLogin(c, await upsertUser(env, identity));
  } catch (err) {
    console.error('Google callback failed:', (err as Error).message);
    return failLogin(c, 'Google sign-in failed. Please try again.');
  }
}
app.get('/google/callback', loginLimiter, googleCallback);

/* ---------------- Apple ---------------- */

function appleClientSecret(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signEs256(
    {
      iss: env.APPLE_TEAM_ID || '',
      iat: now,
      exp: now + 3600,
      aud: 'https://appleid.apple.com',
      sub: env.APPLE_CLIENT_ID || '',
    },
    env.APPLE_PRIVATE_KEY || '',
    env.APPLE_KEY_ID || ''
  );
}

app.get('/apple', loginLimiter, (c) => {
  const cfg = c.get('config');
  if (!providersConfigured(cfg).apple) return failLogin(c, 'Apple sign-in is not configured on this server.');
  const { state, nonce } = startAuth(c);
  const params = new URLSearchParams({
    client_id: c.env.APPLE_CLIENT_ID || '',
    redirect_uri: `${cfg.publicBaseUrl}/api/auth/apple/callback`,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  });
  return c.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

app.post('/apple/callback', loginLimiter, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, any>);
  const code = typeof form.code === 'string' ? form.code : undefined;
  const idToken = typeof form.id_token === 'string' ? form.id_token : undefined;
  const userField = typeof form.user === 'string' ? form.user : undefined;
  const state = typeof form.state === 'string' ? form.state : undefined;
  const sn = readStateNonce(c, state || '');
  if (!code && !idToken) return failLogin(c, 'Invalid or expired sign-in state. Please try again.');
  if (!sn) return failLogin(c, 'Invalid or expired sign-in state. Please try again.');
  try {
    let tokens: { id_token?: string } = {};
    if (code) {
      const tokenRes = await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.APPLE_CLIENT_ID || '',
          client_secret: await appleClientSecret(env),
          redirect_uri: `${cfg.publicBaseUrl}/api/auth/apple/callback`,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) throw new Error(`Apple token exchange failed: ${tokenRes.status}`);
      tokens = (await tokenRes.json()) as { id_token?: string };
    }
    const claims = await verifyOidcToken(tokens.id_token || idToken || '', {
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      issuer: 'https://appleid.apple.com',
      audience: env.APPLE_CLIENT_ID || '',
      nonce: sn.nonce,
    });
    let name = '';
    try {
      const u = typeof userField === 'string' ? JSON.parse(userField) : userField;
      if (u?.name) name = [u.name.firstName, u.name.lastName].filter(Boolean).join(' ');
    } catch {
      /* name only arrives on first authorization; absent afterwards */
    }
    const identity = {
      provider: 'apple',
      sub: claims.sub,
      email: claims.email || '',
      name: name || claims.email?.split('@')[0] || 'Store owner',
      avatarUrl: '',
    };
    return finishLogin(c, await upsertUser(env, identity));
  } catch (err) {
    console.error('Apple callback failed:', (err as Error).message);
    return failLogin(c, 'Apple sign-in failed. Please try again.');
  }
});

/* ---------------- Dev/demo login ---------------- */

app.post('/dev-login', loginLimiter, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  if (!providersConfigured(cfg).dev) return json(c, 403, { error: 'Dev login is disabled.' });
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email || 'owner@example.com').toLowerCase().slice(0, 200);
  const name = String(body?.name || email.split('@')[0]).slice(0, 100);
  const user = await upsertUser(env, { provider: 'dev', sub: email, email, name, avatarUrl: '' });
  await issueSession(c, env, user.id);
  return json(c, 200, { user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/demo-login', loginLimiter, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  if (!providersConfigured(cfg).dev) return json(c, 403, { error: 'Demo login is disabled.' });
  const email = cfg.demoLoginEmail;
  const user = await upsertUser(env, { provider: 'dev', sub: email, email, name: 'Demo Map Owner', avatarUrl: '' });
  await issueSession(c, env, user.id);
  return json(c, 200, { user: { id: user.id, email: user.email, name: user.name } });
});

/* ---------------- Session info ---------------- */

app.get('/me', async (c) => {
  const u = await currentUser(c, c.env);
  return json(c, 200, {
    user: u ? { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, provider: u.provider } : null,
    providers: providersConfigured(c.get('config')),
    selfHosted: c.get('config').selfHosted,
  });
});

app.post('/logout', (c) => {
  clearSession(c);
  return json(c, 200, { ok: true });
});

// OAuth state helpers are exported for potential reuse in tests
export { makeState, checkState, clearState };

export default app;
