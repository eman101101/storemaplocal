/** Public shopper routes (port of backend/src/routes/public.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run } from '../db';
import { json, badRequest } from '../http';
import { ftsExpression } from '../search';

const app = new Hono<AppEnv>();

/** Public store directory search. */
app.get('/stores', async (c) => {
  const env = c.env as Env;
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  const SELECT = `SELECT s.id, s.name, s.slug, s.address, s.description, s.logo_url,
     (SELECT COUNT(*) FROM floors f WHERE f.store_id = s.id) AS floor_count,
     (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
   FROM stores s`;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await all(
      env,
      `${SELECT} WHERE s.is_public = 1 AND (s.name LIKE ? OR s.address LIKE ? OR s.description LIKE ?)
       ORDER BY s.name COLLATE NOCASE LIMIT 30`,
      like, like, like
    );
  } else {
    rows = await all(env, `${SELECT} WHERE s.is_public = 1 ORDER BY s.name COLLATE NOCASE LIMIT 30`);
  }
  return json(c, 200, { stores: rows });
});

/** Full public map payload for the shopper viewer. */
async function publicStorePayload(env: Env, slug: string) {
  const store = await first(env, 'SELECT * FROM stores WHERE slug = ? AND is_public = 1', slug);
  if (!store) return null;
  const { owner_id, is_public, ...pub } = store;
  const floors = await all(
    env,
    'SELECT id, name, level, width_m, height_m, background_url FROM floors WHERE store_id = ? ORDER BY level ASC',
    store.id
  );
  const floorIds = floors.map((f) => f.id as string);
  const elements = floorIds.length
    ? await all(
        env,
        `SELECT id, floor_id, type, shape, geometry, label, color, z_index
         FROM map_elements WHERE floor_id IN (${floorIds.map(() => '?').join(',')})
         ORDER BY z_index ASC, rowid ASC`,
        ...floorIds
      )
    : [];
  const categories = await all(env, 'SELECT id, name, color, icon FROM categories WHERE store_id = ? ORDER BY name', store.id);
  const products = await all(
    env,
    `SELECT p.id, p.name, p.brand, p.sku, p.description, p.price, p.image_url,
            c.name AS category_name, c.color AS category_color
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`,
    store.id
  );
  const locations = await all(
    env,
    `SELECT l.id, l.product_id, l.floor_id, l.x, l.y
     FROM product_locations l JOIN products p ON p.id = l.product_id
     WHERE p.store_id = ?`,
    store.id
  );
  return { store: pub, floors, elements, categories, products, locations };
}

app.get('/stores/:slug', async (c) => {
  const env = c.env as Env;
  const slug = String(c.req.param('slug')).slice(0, 120);
  const payload = await publicStorePayload(env, slug);
  if (!payload) return json(c, 404, { error: 'Store not found' });
  // owner-facing view counter — incremented per origin hit
  await run(env, 'UPDATE stores SET views = views + 1 WHERE id = ?', payload.store.id);
  return json(c, 200, payload);
});

const SEARCH_FIELDS = ['p.name', 'p.brand', 'p.sku', 'p.barcode'];
const SEARCH_SELECT = `SELECT p.id, p.name, p.brand, p.sku, p.price, p.image_url,
        c.name AS category_name, c.color AS category_color,
        l.floor_id, l.x, l.y,
        f.name AS floor_name
 FROM products p
 LEFT JOIN categories c ON c.id = p.category_id
 LEFT JOIN product_locations l ON l.product_id = p.id
 LEFT JOIN floors f ON f.id = l.floor_id`;

app.get('/stores/:slug/search', async (c) => {
  const env = c.env as Env;
  const slug = String(c.req.param('slug')).slice(0, 120);
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  const store = await first(env, 'SELECT id FROM stores WHERE slug = ? AND is_public = 1', slug);
  if (!store) return json(c, 404, { error: 'Store not found' });
  if (!q) return json(c, 200, { results: [] });

  // FTS5 path: inverted-index prefix match — a keystroke is an index lookup,
  // not a catalog scan (see backend migration 006 / lib/search.js).
  const match = ftsExpression(q);
  let results;
  if (match) {
    results = await all(
      env,
      `${SEARCH_SELECT}
       JOIN products_fts fts ON fts.rowid = p.rowid
       WHERE products_fts MATCH ? AND p.store_id = ?
       ORDER BY p.name COLLATE NOCASE LIMIT 40`,
      match, store.id
    );
  } else {
    const like = `%${q}%`;
    const where = SEARCH_FIELDS.map((f) => `${f} LIKE ?`).join(' OR ');
    results = await all(
      env,
      `${SEARCH_SELECT}
       WHERE p.store_id = ? AND (${where} OR c.name LIKE ?)
       ORDER BY p.name COLLATE NOCASE LIMIT 40`,
      store.id, like, like, like, like, `%${q}%`
    );
  }
  return json(c, 200, { results });
});

export default app;
