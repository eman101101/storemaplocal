/**
 * Cloudflare Access (Zero Trust) integration — the "built-in auth" option.
 *
 * When an Access application protects the dashboard + owner API paths, the
 * edge injects a signed `Cf-Access-Jwt-Assertion` header on every request that
 * passed the login wall. Set ACCESS_TEAM_DOMAIN (yourteam.cloudflareaccess.com)
 * and — recommended — ACCESS_AUD (the app's AUD tag) and the worker verifies
 * that token against your team's public certs and maps the email to a user,
 * so the editor works with zero in-app sign-in.
 */
import type { Context } from 'hono';
import type { Env } from './config';
import { fetchJwks, verifyEs256WithKeys } from './crypto';
import { first } from './db';
import { upsertUser, type UserRow } from './session';

export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN);
}

function teamDomain(raw: string): string {
  return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Verify the Access JWT and return its claims, or null if absent/unconfigured. */
export async function verifyAccessToken(c: Context, env: Env): Promise<Record<string, any> | null> {
  const token = c.req.header('cf-access-jwt-assertion');
  if (!token || !accessConfigured(env)) return null;
  const team = teamDomain(env.ACCESS_TEAM_DOMAIN!);
  const keys = await fetchJwks(`https://${team}/cdn-cgi/access/certs`);
  return await verifyEs256WithKeys(token, keys, {
    issuer: `https://${team}`,
    audience: env.ACCESS_AUD || undefined,
  });
}

/**
 * Resolve (or lazily create) the app user for an Access-authenticated email.
 * Returns null when the request carries no Access token.
 */
export async function userFromAccess(c: Context, env: Env): Promise<UserRow | null> {
  const claims = await verifyAccessToken(c, env);
  if (!claims) return null;
  const email = String(claims.email || '').toLowerCase();
  if (!email) return null; // Access policy didn't include an email claim
  const existing = (await first(env, 'SELECT id, email, name, avatar_url, provider FROM users WHERE email = ?', email)) as UserRow | null;
  if (existing) return existing;
  return upsertUser(env, {
    provider: 'dev', // reuses the schema's passwordless identity class
    sub: `access:${claims.sub || email}`,
    email,
    name: String(claims.name || email.split('@')[0]),
    avatarUrl: '',
  });
}
