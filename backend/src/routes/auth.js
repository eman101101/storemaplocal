import { Router, urlencoded } from 'express';
import { config, providersConfigured } from '../config.js';
import { handler, sendJson, setCookie, clearCookie, parseCookies, rateLimit } from '../lib/http.js';
import { randomToken } from '../lib/jwt.js';
import { issueSession, clearSession, upsertUser, currentUser } from '../auth/session.js';
import * as google from '../auth/google.js';
import * as apple from '../auth/apple.js';

const router = Router();

const STATE_COOKIE = 'st_oauth';

/** OAuth state + nonce round-trip in one short-lived cookie: "<state>.<nonce>". */
function startAuth(res) {
  const state = randomToken(20);
  const nonce = randomToken(16);
  setCookie(res, STATE_COOKIE, `${state}.${nonce}`, { maxAge: 600 });
  return { state, nonce };
}

function readStateNonce(req, state) {
  const raw = parseCookies(req)[STATE_COOKIE];
  if (!raw || !state) return null;
  const [st, nonce] = raw.split('.');
  if (st !== state) return null;
  return { nonce };
}

function finishLogin(res, user) {
  issueSession(res, user.id);
  clearCookie(res, STATE_COOKIE);
  res.redirect('/dashboard?login=success');
}

function failLogin(res, message) {
  clearCookie(res, STATE_COOKIE);
  res.redirect(`/login?error=${encodeURIComponent(message)}`);
}

const loginLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// ---- Google ----
router.get('/google', loginLimiter, (req, res) => {
  if (!google.googleEnabled()) return failLogin(res, 'Google sign-in is not configured on this server.');
  const { state, nonce } = startAuth(res);
  res.redirect(google.authorizeUrl({ state, nonce }));
});

router.get('/google/callback', loginLimiter, handler(async (req, res) => {
  const { code, state } = req.query;
  const sn = readStateNonce(req, String(state || ''));
  if (!code || !sn) return failLogin(res, 'Invalid or expired sign-in state. Please try again.');
  try {
    const identity = await google.handleCallback({ code: String(code), nonce: sn.nonce });
    finishLogin(res, upsertUser(identity));
  } catch (err) {
    console.error('Google callback failed:', err.message);
    failLogin(res, 'Google sign-in failed. Please try again.');
  }
}));

// ---- Apple (browser POSTs back: code + id_token, response_mode=form_post) ----
router.get('/apple', loginLimiter, (req, res) => {
  if (!apple.appleEnabled()) return failLogin(res, 'Apple sign-in is not configured on this server.');
  const { state, nonce } = startAuth(res);
  res.redirect(apple.authorizeUrl({ state, nonce }));
});

router.post(
  '/apple/callback',
  urlencoded({ extended: false }),
  loginLimiter,
  handler(async (req, res) => {
    const { code, id_token: idToken, state, user } = req.body ?? {};
    const sn = readStateNonce(req, String(state || ''));
    if ((!code && !idToken) || !sn) {
      return failLogin(res, 'Invalid or expired sign-in state. Please try again.');
    }
    try {
      const identity = await apple.handleCallback({
        code: code ? String(code) : undefined,
        idToken: idToken ? String(idToken) : undefined,
        nonce: sn.nonce,
        userField: user,
      });
      finishLogin(res, upsertUser(identity));
    } catch (err) {
      console.error('Apple callback failed:', err.message);
      failLogin(res, 'Apple sign-in failed. Please try again.');
    }
  })
);

// ---- Dev/demo login (disabled in production unless ENABLE_DEV_LOGIN=true) ----
router.post('/dev-login', loginLimiter, handler(async (req, res) => {
  if (!providersConfigured().dev) return sendJson(res, 403, { error: 'Dev login is disabled.' });
  const email = String(req.body?.email || 'owner@example.com').toLowerCase().slice(0, 200);
  const name = String(req.body?.name || email.split('@')[0]).slice(0, 100);
  const user = upsertUser({ provider: 'dev', sub: email, email, name, avatarUrl: '' });
  issueSession(res, user.id);
  sendJson(res, 200, { user: { id: user.id, email: user.email, name: user.name } });
}));

// ---- One-click demo login: the account that owns the seeded demo maps ----
// Same gate as dev-login (never available in production unless explicitly
// enabled), but no form: the login page links straight here so anyone can
// open and edit the demo/test maps without typing anything.
router.post('/demo-login', loginLimiter, handler(async (_req, res) => {
  if (!providersConfigured().dev) return sendJson(res, 403, { error: 'Demo login is disabled.' });
  const email = config.demoLoginEmail;
  const user = upsertUser({ provider: 'dev', sub: email, email, name: 'Demo Map Owner', avatarUrl: '' });
  issueSession(res, user.id);
  sendJson(res, 200, { user: { id: user.id, email: user.email, name: user.name } });
}));

// ---- Session info ----
router.get('/me', (req, res) => {
  const u = currentUser(req);
  sendJson(res, 200, {
    user: u ? { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, provider: u.provider } : null,
    providers: providersConfigured(),
    selfHosted: config.selfHosted,
  });
});

router.post('/logout', (_req, res) => {
  clearSession(res);
  sendJson(res, 200, { ok: true });
});

export default router;
