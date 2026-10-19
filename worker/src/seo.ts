/**
 * SEO plumbing (port of app.js sitemap/robots/store-meta sections): sitemap,
 * robots.txt, and social-share metadata injected into /s/:slug HTML.
 * The SPA HTML comes from the ASSETS binding.
 */
import type { Context } from 'hono';
import type { Env } from './config';
import { all, first, count } from './db';

export async function sitemap(c: Context): Promise<Response> {
  const env = c.env as Env;
  const cfg = c.get('config');
  const rows = await all(env, 'SELECT slug, updated_at FROM stores WHERE is_public = 1');
  const urls = rows
    .map(
      (r) =>
        `  <url><loc>${cfg.publicBaseUrl}/s/${r.slug}</loc><lastmod>${String(r.updated_at).slice(0, 10)}</lastmod></url>`
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${cfg.publicBaseUrl}/</loc></url>\n${urls}\n</urlset>`,
    { headers: { 'Content-Type': 'application/xml' } }
  );
}

export function robots(c: Context): Response {
  const cfg = c.get('config');
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${cfg.publicBaseUrl}/sitemap.xml\n`, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function assetIndex(c: Context): Promise<string | null> {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url).toString()));
  if (!res.ok) return null;
  return await res.text();
}

/**
 * Shopper links (/s/:slug) get real social-share metadata: QR scans and
 * shared links preview the store name/logo instead of the generic SPA tag.
 * All other GETs fall through to the plain SPA index.
 */
export async function serveSpa(c: Context): Promise<Response> {
  const env = c.env as Env;
  const cfg = c.get('config');
  const path = new URL(c.req.url).pathname;
  const html = await assetIndex(c);
  if (html === null) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  const slugMatch = path.match(/^\/s\/([A-Za-z0-9_-]{1,120})$/);
  if (!slugMatch) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const store = await first(
    env,
    'SELECT id, name, description, logo_url, address, phone, hours, lat, lng FROM stores WHERE slug = ? AND is_public = 1',
    slugMatch[1]
  );
  if (!store) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const cats = (await all(env, 'SELECT name FROM categories WHERE store_id = ? ORDER BY name LIMIT 12', store.id)).map(
    (cat) => cat.name as string
  );
  const prodCount = await count(env, 'SELECT COUNT(*) n FROM products WHERE store_id = ?', store.id);
  const title = `${store.name} — find it on the map`;
  const desc =
    (store.description as string) ||
    `${prodCount} products mapped${cats.length ? ` across ${cats.join(', ')}` : ''}. Search any item and see exactly where it is.`;
  const abs = (u: unknown) => (u && /^https?:/.test(String(u)) ? String(u) : u ? cfg.publicBaseUrl + u : '');
  const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: store.name,
    description: desc,
    ...(store.address ? { address: store.address } : {}),
    ...(store.phone ? { telephone: store.phone } : {}),
    ...(store.logo_url ? { image: abs(store.logo_url) } : {}),
    ...(store.lat && store.lng ? { geo: { '@type': 'GeoCoordinates', latitude: store.lat, longitude: store.lng } } : {}),
    ...(store.hours ? { openingHours: store.hours } : {}),
  });
  const noscript = `<noscript><h1>${esc(store.name)}</h1><p>${esc(desc)}</p>${
    store.hours ? `<p>Hours: ${esc(store.hours)}</p>` : ''
  }${store.address ? `<p>Address: ${esc(store.address)}</p>` : ''}</noscript>`;
  const metas = [
    ['og:title', title],
    ['og:description', desc],
    ['og:type', 'website'],
    ['og:url', `${cfg.publicBaseUrl}/s/${slugMatch[1]}`],
    ...(store.logo_url ? [['og:image', abs(store.logo_url)]] : []),
    ['twitter:card', store.logo_url ? 'summary_large_image' : 'summary'],
    ['twitter:title', title],
    ['twitter:description', desc],
  ]
    .map(([k, v]) => `<meta property="${k}" content="${String(v).replace(/"/g, '&quot;')}">`)
    .join('');
  const out = html
    .replace('</title>', `</title>${metas}<script type="application/ld+json">${jsonLd}</script>`)
    .replace('<title>StoreMap — Find products in-store</title>', `<title>${esc(store.name)} · StoreMap</title>`)
    .replace('<div id="root"></div>', `${noscript}<div id="root"></div>`);
  return new Response(out, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
