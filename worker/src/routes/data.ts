/** CSV interchange + StockTrack v1 API (ports of integrations.js and v1.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run } from '../db';
import { json, badRequest, rateLimit } from '../http';
import { ownedStore } from '../ownership';
import { requireAuth } from '../session';
import { rowsFromCsv, toCsv } from '../csv';
import { upsertProduct, storeForApiKey, keyFromHeaders, adjustStock, setStock, stockForStore } from '../stock';

/* ---------------- CSV interchange (owner) ---------------- */

const csv = new Hono<AppEnv>();
csv.use('*', async (c, next) => {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
});

csv.post('/:storeId/integrations/csv', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const rows = rowsFromCsv(String(body?.csv ?? ''));
  if (!rows.length) return badRequest(c, 'No rows found in CSV (need a header row with name/sku columns)');
  let imported = 0;
  for (const row of rows) {
    const result = await upsertProduct(env, store.id, row, { source: 'sync:csv' });
    if (result) imported += 1;
  }
  return json(c, 200, { imported, total: rows.length });
});

csv.get('/:storeId/catalog.csv', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const rows = await all(
    env,
    `SELECT p.name, p.brand, p.sku, p.barcode, p.price, c.name AS category,
            COALESCE(sl.quantity, '') AS quantity
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN stock_levels sl ON sl.product_id = p.id
     WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`,
    store.id
  );
  const csvBody = toCsv(rows);
  return new Response(csvBody, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${store.slug}-catalog.csv"`,
    },
  });
});

/* ---------------- StockTrack v1 (API key) ---------------- */

const v1 = new Hono<AppEnv>();
const v1Limiter = rateLimit({ windowMs: 60_000, max: 300 });

v1.use('*', v1Limiter);
v1.use('*', async (c, next) => {
  const env = c.env as Env;
  const store = await storeForApiKey(env, keyFromHeaders(c.req.header('authorization'), c.req.header('x-api-key')));
  if (!store) {
    c.header('WWW-Authenticate', 'Bearer realm="stocktrack-v1"');
    return json(c, 401, { error: 'A valid API key is required (Authorization: Bearer skm_…)' });
  }
  c.set('store', store);
  await next();
});

v1.get('/store', (c) => {
  const store = c.get('store');
  return json(c, 200, { store: { id: store.id, name: store.name, slug: store.slug } });
});

v1.get('/products', async (c) => {
  const env = c.env as Env;
  const products = await all(
    env,
    `SELECT p.id, p.name, p.brand, p.sku, p.barcode, p.price, c.name AS category_name
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`,
    c.get('store').id
  );
  return json(c, 200, { products });
});

v1.get('/stock', async (c) => {
  const env = c.env as Env;
  const stock = await stockForStore(env, c.get('store').id);
  const items = stock.map((s) =>
    c.req.query('include_products')
      ? s
      : { product_id: s.product_id, sku: s.sku, barcode: s.barcode, quantity: s.quantity ?? 0 }
  );
  return json(c, 200, { items });
});

v1.post('/products', async (c) => {
  const env = c.env as Env;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return badRequest(c, 'JSON body required');
  try {
    const result = await upsertProduct(env, c.get('store').id, b, { source: 'api' });
    if (!result) return badRequest(c, 'Provide at least one of name, sku or barcode');
    return json(c, result.created ? 201 : 200, result);
  } catch (err) {
    return badRequest(c, (err as Error).message);
  }
});

async function resolveProduct(c: any, env: Env): Promise<string | null> {
  const b = await c.req.json().catch(() => ({}));
  c.set('body', b ?? {});
  const store = c.get('store');
  let row = null;
  if (b?.product_id) row = await first(env, 'SELECT id FROM products WHERE id = ? AND store_id = ?', String(b.product_id), store.id);
  if (!row && b?.sku) row = await first(env, 'SELECT id FROM products WHERE store_id = ? AND sku = ?', store.id, String(b.sku));
  if (!row && b?.barcode) row = await first(env, 'SELECT id FROM products WHERE store_id = ? AND barcode = ?', store.id, String(b.barcode));
  if (!row) {
    badRequest(c, 'Unknown product: pass product_id, sku or barcode');
    return null;
  }
  return row.id as string;
}

v1.post('/stock/adjust', async (c) => {
  const env = c.env as Env;
  const productId = await resolveProduct(c, env);
  if (!productId) return;
  const b = c.get('body');
  const delta = Number(b?.delta);
  if (!Number.isFinite(delta)) return badRequest(c, 'delta must be a number');
  try {
    const level = await adjustStock(env, c.get('store').id, productId, delta, {
      reason: b?.reason,
      source: String(b?.source || 'api').slice(0, 40),
    });
    return json(c, 200, { level });
  } catch (err) {
    return badRequest(c, (err as Error).message);
  }
});

v1.post('/stock/set', async (c) => {
  const env = c.env as Env;
  const productId = await resolveProduct(c, env);
  if (!productId) return;
  const b = c.get('body');
  const quantity = Number(b?.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) return badRequest(c, 'quantity must be a non-negative number');
  try {
    const level = await setStock(env, c.get('store').id, productId, quantity, {
      reason: b?.reason,
      source: String(b?.source || 'api').slice(0, 40),
    });
    return json(c, 200, { level });
  } catch (err) {
    return badRequest(c, (err as Error).message);
  }
});

v1.get('/map', async (c) => {
  const env = c.env as Env;
  const storeId = c.get('store').id;
  const floors = await all(env, 'SELECT id, name, level, width_m, height_m FROM floors WHERE store_id = ?', storeId);
  const ids = floors.map((f) => f.id as string);
  const elements = ids.length
    ? await all(
        env,
        `SELECT id, floor_id, type, shape, geometry, label, color, meta, z_index
         FROM map_elements WHERE floor_id IN (${ids.map(() => '?').join(',')})`,
        ...ids
      )
    : [];
  return json(c, 200, { floors, elements });
});

export { csv, v1 };
