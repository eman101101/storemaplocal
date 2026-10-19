/**
 * StoreMap Cloudflare Worker — entry point.
 * Same-origin single deployment: /api/* (Hono + D1), /uploads/* (R2), SEO
 * routes, and the built SPA served from the ASSETS binding by the platform.
 */
import { Hono } from 'hono';
import type { Env, AppEnv } from './config';
import { makeConfig, providersConfigured } from './config';
import { bootstrap } from './migrate';
import { attachUser } from './session';
import { json } from './http';
import { serveImage } from './storage';
import authRoutes from './routes/auth';
import storeRoutes from './routes/stores';
import floorRoutes from './routes/floors';
import catalogRoutes from './routes/catalog';
import publicRoutes from './routes/public';
import uploadRoutes from './routes/uploads';
import stockRoutes from './routes/stock';
import { csv, v1 } from './routes/data';
import { sitemap, robots, serveSpa } from './seo';

type AppEnvFull = AppEnv & { Variables: { user: any; config: any; store: any; body: any } };

const app = new Hono<AppEnvFull>();

/* ---- Per-request setup: config from bindings, then first-boot bootstrap.
 * Mounted globally: /s/* and SEO routes need config too (bootstrap itself is
 * memoised per isolate, so the cost is one-time). ---- */
app.use('*', async (c, next) => {
  const origin = new URL(c.req.url).origin;
  const cfg = makeConfig(c.env, origin);
  // First boot on a fresh D1: migrations + generated session secret + demo maps.
  cfg.sessionSecret = await bootstrap(c.env, cfg.selfHosted);
  c.set('config', cfg);
  await next();
});

/* ---- Security headers (SPA-friendly CSP, mirrors the Express app) ---- */
app.use('/api/*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cache-Control', 'no-store');
});

app.use('/api/*', attachUser);

app.get('/api/health', (c) => {
  return json(c, 200, { ok: true, service: 'storemap', runtime: 'cloudflare-workers', time: new Date().toISOString() });
});

app.route('/api/auth', authRoutes);
app.route('/api/stores', storeRoutes);
app.route('/api/stores', stockRoutes);
app.route('/api/stores', csv);
app.route('/api/floors', floorRoutes);
app.route('/api/public', publicRoutes);
app.route('/api/v1', v1);
app.route('/api', catalogRoutes);
app.route('/api/uploads', uploadRoutes);

app.all('/api/*', (c) => json(c, 404, { error: 'Unknown API endpoint' }));

/* ---- Uploaded images from R2 ---- */
app.get('/uploads/:name', async (c) => {
  try {
    const res = await serveImage(c.env, c.req.param('name'));
    return res ?? c.body(null, 404);
  } catch (err) {
    console.error('uploads serve failed:', err);
    return c.body(null, 502);
  }
});

/* ---- SEO + shopper share links ---- */
app.get('/sitemap.xml', (c) => sitemap(c));
app.get('/robots.txt', (c) => robots(c));
app.get('/s/*', (c) => serveSpa(c));

/* ---- Login provider availability for the SPA shell (cheap, cached per isolate) ---- */
app.get('/api/boot/providers', (c) => json(c, 200, providersConfigured(c.get('config'))));

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    // /s/:slug pages and SEO paths run through the worker (run_worker_first in
    // wrangler.jsonc); everything else is served straight from the asset CDN.
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads') || url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
      return app.fetch(request, env, ctx as any);
    }
    if (url.pathname.startsWith('/s/')) {
      // serveSpa needs the Hono context helpers — route through the app.
      return app.fetch(request, env, ctx as any);
    }
    return env.ASSETS.fetch(request);
  },
};
