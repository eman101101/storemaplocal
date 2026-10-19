/** Upload route — raw image bytes to R2 (port of uploads.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { saveImage } from '../storage';
import { json, badRequest, rateLimit } from '../http';
import { requireAuth } from '../session';

const app = new Hono<AppEnv>();

const ALLOWED: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/png': { ext: '.png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': {
    ext: '.webp',
    magic: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
};

const limiter = rateLimit({ windowMs: 60_000, max: 20 });

app.post('/', requireAuth, limiter, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  // Raw-body upload avoids multipart parsing: the client POSTs the file bytes directly.
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  const spec = ALLOWED[type];
  if (!spec) return badRequest(c, 'Only PNG, JPEG or WebP images are accepted');
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.length) return badRequest(c, 'Empty upload');
  if (buf.length > cfg.maxUploadBytes) return badRequest(c, 'Image exceeds 10 MB limit');
  if (!spec.magic(buf)) return badRequest(c, 'File content does not match its image type');

  try {
    const { url } = await saveImage(env, buf, spec.ext);
    return json(c, 201, { url });
  } catch (err) {
    if ((err as Error).message === 'R2_DAILY_BUDGET_REACHED')
      return json(c, 503, { error: 'Daily media budget reached — uploads pause until tomorrow.', retry: true });
    throw err;
  }
});

export default app;
