import { Router } from 'express';
import { db } from '../db.js';
import { handler, sendJson, badRequest } from '../lib/http.js';
import { edgeCache } from '../lib/cdn.js';
import { ftsExpression } from '../lib/search.js';

const router = Router();

/** Public store directory search. */
router.get('/stores', handler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db
      .prepare(
        `SELECT s.id, s.name, s.slug, s.address, s.description, s.logo_url,
           (SELECT COUNT(*) FROM floors f WHERE f.store_id = s.id) AS floor_count,
           (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
         FROM stores s
         WHERE s.is_public = 1 AND (s.name LIKE ? OR s.address LIKE ? OR s.description LIKE ?)
         ORDER BY s.name COLLATE NOCASE LIMIT 30`
      )
      .all(like, like, like);
  } else {
    rows = db
      .prepare(
        `SELECT s.id, s.name, s.slug, s.address, s.description, s.logo_url,
           (SELECT COUNT(*) FROM floors f WHERE f.store_id = s.id) AS floor_count,
           (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
         FROM stores s WHERE s.is_public = 1 ORDER BY s.name COLLATE NOCASE LIMIT 30`
      )
      .all();
  }
  sendJson(res, 200, { stores: rows });
}));

/** Full public map payload for the shopper viewer. */
function publicStorePayload(slug) {
  const store = db.prepare('SELECT * FROM stores WHERE slug = ? AND is_public = 1').get(slug);
  if (!store) return null;
  const { owner_id, is_public, ...pub } = store;
  const floors = db
    .prepare('SELECT id, name, level, width_m, height_m, background_url FROM floors WHERE store_id = ? ORDER BY level ASC')
    .all(store.id);
  const floorIds = floors.map((f) => f.id);
  const elements = floorIds.length
    ? db.prepare(
        `SELECT id, floor_id, type, shape, geometry, label, color, z_index
         FROM map_elements WHERE floor_id IN (${floorIds.map(() => '?').join(',')})
         ORDER BY z_index ASC, rowid ASC`
      ).all(...floorIds)
    : [];
  const categories = db
    .prepare('SELECT id, name, color, icon FROM categories WHERE store_id = ? ORDER BY name')
    .all(store.id);
  const products = db
    .prepare(
      `SELECT p.id, p.name, p.brand, p.sku, p.description, p.price, p.image_url,
              c.name AS category_name, c.color AS category_color
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`
    )
    .all(store.id);
  const locations = db
    .prepare(
      `SELECT l.id, l.product_id, l.floor_id, l.x, l.y
       FROM product_locations l JOIN products p ON p.id = l.product_id
       WHERE p.store_id = ?`
    )
    .all(store.id);
  return { store: pub, floors, elements, categories, products, locations };
}

router.get('/stores/:slug', handler(async (req, res) => {
  const slug = String(req.params.slug).slice(0, 120);
  const payload = publicStorePayload(slug);
  if (!payload) return sendJson(res, 404, { error: 'Store not found' });
  edgeCache(res, payload.store.id); // CDN: 5 min at the edge, per-store purge tag
  // owner-facing view counter: incremented on origin hits only (edge-cached
  // responses don't reach us), which keeps it a stable relative signal.
  db.prepare('UPDATE stores SET views = views + 1 WHERE id = ?').run(payload.store.id);
  sendJson(res, 200, payload);
}));

const SEARCH_FIELDS = ['p.name', 'p.brand', 'p.sku', 'p.barcode'];
const SEARCH_SELECT = `SELECT p.id, p.name, p.brand, p.sku, p.price, p.image_url,
        c.name AS category_name, c.color AS category_color,
        l.floor_id, l.x, l.y,
        f.name AS floor_name
 FROM products p
 LEFT JOIN categories c ON c.id = p.category_id
 LEFT JOIN product_locations l ON l.product_id = p.id
 LEFT JOIN floors f ON f.id = l.floor_id`;

router.get('/stores/:slug/search', handler(async (req, res) => {
  const slug = String(req.params.slug).slice(0, 120);
  const q = String(req.query.q || '').trim().slice(0, 100);
  const store = db.prepare('SELECT id FROM stores WHERE slug = ? AND is_public = 1').get(slug);
  if (!store) return sendJson(res, 404, { error: 'Store not found' });
  if (!q) return sendJson(res, 200, { results: [] });

  // FTS5 path: inverted-index prefix match (name, brand, sku, barcode AND
  // category name, denormalized into the index) — a keystroke costs an index
  // lookup instead of a full catalog scan.
  const match = ftsExpression(q);
  let results;
  if (match) {
    results = db
      .prepare(
        `${SEARCH_SELECT}
         JOIN products_fts fts ON fts.rowid = p.rowid
         WHERE products_fts MATCH ? AND p.store_id = ?
         ORDER BY p.name COLLATE NOCASE LIMIT 40`
      )
      .all(match, store.id);
  } else {
    // Fallback for input with no word characters (e.g. "###").
    const like = `%${q}%`;
    const where = SEARCH_FIELDS.map((f) => `${f} LIKE ?`).join(' OR ');
    results = db
      .prepare(
        `${SEARCH_SELECT}
         WHERE p.store_id = ? AND (${where} OR c.name LIKE ?)
         ORDER BY p.name COLLATE NOCASE LIMIT 40`
      )
      .all(store.id, like, like, like, like, `%${q}%`);
  }
  sendJson(res, 200, { results });
}));

export default router;
