/** Sessions + user upsert (port of backend/src/auth/session.js) on D1. */
import type { Context } from 'hono';
import type { Env } from './config';
import { signHs256, verifyHs256 } from './crypto';
import { first, run } from './db';
import { newId } from './util';
import { parseCookies, setCookie, clearCookie } from './cookies';
import { json } from './http';

const COOKIE = 'st_session';
const STATE_COOKIE = 'st_oauth';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string;
  provider: string;
  [key: string]: unknown;
}

export async function issueSession(c: Context, env: Env, userId: string): Promise<void> {
  const cfg = c.get('config');
  const now = Math.floor(Date.now() / 1000);
  const token = await signHs256({ sub: userId, iat: now, exp: now + cfg.sessionDays * 86400 }, cfg.sessionSecret);
  setCookie(c, COOKIE, token, { maxAge: cfg.sessionDays * 86400 });
}

export function clearSession(c: Context): void {
  clearCookie(c, COOKIE);
}

export async function currentUser(c: Context, env: Env): Promise<UserRow | null> {
  const token = parseCookies(c)[COOKIE];
  if (token) {
    try {
      const cfg = c.get('config');
      const payload = await verifyHs256(token, cfg.sessionSecret);
      if (payload.sub && payload.exp * 1000 >= Date.now()) {
        const user = await first(env, 'SELECT id, email, name, avatar_url, provider FROM users WHERE id = ?', payload.sub);
        if (user) return user as UserRow;
      }
    } catch {
      /* bad/Expired cookie — fall through to Cloudflare Access */
    }
  }
  // Cloudflare Access: the edge verified the visitor and injected a signed
  // assertion; map its email to a user (no-op unless ACCESS_TEAM_DOMAIN is set).
  const { userFromAccess } = await import('./access');
  return userFromAccess(c, env);
}

/** Hono middleware: resolves c.get('user') for every /api request. */
export async function attachUser(c: Context, next: () => Promise<void>): Promise<void> {
  const env = c.env as Env;
  c.set('user', await currentUser(c, env));
  await next();
}

export async function requireAuth(c: Context, next: () => Promise<void>): Promise<Response | void> {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
}

/** OAuth state round-trip: random value stored in a short-lived cookie. */
export function makeState(c: Context): string {
  const state = crypto.randomUUID().replace(/-/g, '');
  setCookie(c, STATE_COOKIE, state, { maxAge: 600 });
  return state;
}

export function checkState(c: Context, state: unknown): boolean {
  const expected = parseCookies(c)[STATE_COOKIE];
  return Boolean(state) && Boolean(expected) && state === expected;
}

export function clearState(c: Context): void {
  clearCookie(c, STATE_COOKIE);
}

/** Upsert a user from an OIDC identity claim set (or dev login). */
export async function upsertUser(env: Env, { provider, sub, email, name, avatarUrl }: {
  provider: string;
  sub: string;
  email: string;
  name: string;
  avatarUrl: string;
}): Promise<UserRow> {
  const existing = await first(env, 'SELECT * FROM users WHERE provider = ? AND provider_sub = ?', provider, sub);
  if (existing) {
    await run(
      env,
      'UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?',
      email || existing.email,
      name ?? existing.name,
      avatarUrl ?? existing.avatar_url,
      existing.id
    );
    return (await first(env, 'SELECT * FROM users WHERE id = ?', existing.id)) as UserRow;
  }
  const byEmail = await first(env, 'SELECT * FROM users WHERE email = ?', email);
  if (byEmail) {
    // Same human, new provider — link the identity instead of creating a dupe.
    await run(
      env,
      `UPDATE users SET provider = ?, provider_sub = ?, name = COALESCE(NULLIF(?, ''), name),
       avatar_url = COALESCE(NULLIF(?, ''), avatar_url) WHERE id = ?`,
      provider, sub, name ?? '', avatarUrl ?? '', byEmail.id
    );
    return (await first(env, 'SELECT * FROM users WHERE id = ?', byEmail.id)) as UserRow;
  }
  const id = newId();
  await run(
    env,
    'INSERT INTO users (id, email, name, avatar_url, provider, provider_sub) VALUES (?, ?, ?, ?, ?, ?)',
    id, email, name ?? '', avatarUrl ?? '', provider, sub
  );
  return (await first(env, 'SELECT * FROM users WHERE id = ?', id)) as UserRow;
}
