/**
 * Media storage on the R2 binding (port of backend/src/lib/storage.js).
 * Workers deployments are R2-only — the legacy local-disk branch doesn't apply.
 */
import type { Env } from './config';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Persist an image buffer. Returns the public URL path (`/uploads/<name>`). */
export async function saveImage(env: Env, buf: Uint8Array, ext: string): Promise<{ name: string; url: string }> {
  const name = `${crypto.randomUUID()}${ext}`;
  await env.MEDIA.put(`uploads/${name}`, buf as unknown as ArrayBuffer);
  return { name, url: `/uploads/${name}` };
}

/** Serve an uploaded image, or null (caller sends 404). Immutable long cache. */
export async function serveImage(env: Env, name: string): Promise<Response | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null; // no path tricks
  const obj = await env.MEDIA.get(`uploads/${name}`);
  if (!obj) return null;
  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()];
  if (type) headers.set('Content-Type', type);
  else if (obj.httpMetadata?.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
  return new Response(obj.body, { headers });
}
