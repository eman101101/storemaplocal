/** Cookie parsing/serialising on Hono contexts (port of the http.js cookie helpers). */
import type { Context } from 'hono';

export function parseCookies(c: Context): Record<string, string> {
  const header = c.req.header('cookie') || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[k] = part.slice(i + 1).trim();
      }
    }
  }
  return out;
}

export function setCookieRaw(c: Context, cookie: string): void {
  c.header('Set-Cookie', cookie, { append: true });
}

export function setCookie(
  c: Context,
  name: string,
  value: string,
  { maxAge, httpOnly = true, path = '/' }: { maxAge?: number; httpOnly?: boolean; path?: string } = {}
): void {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=Lax`;
  if (httpOnly) cookie += '; HttpOnly';
  if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
  // Workers always sit behind a TLS-terminating edge; Secure is correct here.
  cookie += '; Secure';
  setCookieRaw(c, cookie);
}

export function clearCookie(c: Context, name: string): void {
  setCookieRaw(c, `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
}
