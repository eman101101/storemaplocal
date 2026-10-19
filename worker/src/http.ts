/** HTTP helpers ported from backend/src/lib/http.js (Hono-flavoured). */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export function json(c: Context, status: number, body: unknown): Response {
  return c.json(body as any, status as ContentfulStatusCode);
}

export function badRequest(c: Context, message: string): Response {
  return json(c, 400, { error: message });
}

export function notFound(c: Context, message = 'Not found'): Response {
  return json(c, 404, { error: message });
}

export function slugify(text: unknown): string {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'store';
}

export function requireFields(c: Context, body: any, fields: string[]): boolean {
  for (const f of fields) {
    if (body?.[f] === undefined || body?.[f] === null || body?.[f] === '') {
      badRequest(c, `Missing field: ${f}`);
      return false;
    }
  }
  return true;
}

/**
 * Best-effort fixed-window rate limiter, per isolate (Workers keep one isolate
 * warm per POP, so this throttles bursts; it is not a global quota).
 */
export function rateLimit({ windowMs = 60_000, max = 100 }: { windowMs?: number; max?: number } = {}) {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c: Context, next: () => Promise<void>) => {
    const ip =
      c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const now = Date.now();
    let win = hits.get(ip);
    if (!win || win.reset < now) {
      win = { count: 0, reset: now + windowMs };
      hits.set(ip, win);
    }
    win.count += 1;
    if (win.count > max) {
      c.header('Retry-After', String(Math.ceil((win.reset - now) / 1000)));
      return json(c, 429, { error: 'Too many requests' });
    }
    await next();
  };
}
