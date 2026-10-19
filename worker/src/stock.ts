/** Stock tracking core (port of backend/src/lib/stock.js) on D1. */
import type { Env } from './config';
import { all, first, run, stmt } from './db';
import { newId, sha256Hex, randomToken } from './util';

/**
 * Apply a signed delta to a product's stock level and log the movement.
 * One atomic D1 batch: upsert level → apply delta → log the movement (its
 * resulting_quantity comes straight from the updated row) → read the level back.
 */
export async function adjustStock(
  env: Env,
  storeId: string,
  productId: string,
  delta: number,
  { reason = '', source = 'manual' }: { reason?: string; source?: string } = {}
): Promise<Record<string, unknown> | null> {
  const product = await first(env, 'SELECT id FROM products WHERE id = ? AND store_id = ?', String(productId), String(storeId));
  if (!product) return null;

  const d = Number(delta);
  if (!Number.isFinite(d)) throw new Error('delta must be a number');

  const results = await env.DB.batch([
    stmt(env, 'INSERT OR IGNORE INTO stock_levels (product_id, quantity) VALUES (?, 0)', product.id),
    stmt(env, `UPDATE stock_levels SET quantity = quantity + ?, updated_at = datetime('now') WHERE product_id = ?`, d, product.id),
    stmt(
      env,
      `INSERT INTO stock_movements (id, product_id, delta, resulting_quantity, reason, source)
       SELECT ?, ?, ?, quantity, ?, ? FROM stock_levels WHERE product_id = ?`,
      newId(), product.id, d, String(reason).slice(0, 200), String(source).slice(0, 40), product.id
    ),
    stmt(env, 'SELECT * FROM stock_levels WHERE product_id = ?', product.id),
  ]);
  const selectResult = results[results.length - 1] as unknown as { results?: Record<string, unknown>[] };
  return selectResult.results?.[0] ?? null;
}

/** Set an absolute quantity (logged as the delta that produced it). */
export async function setStock(
  env: Env,
  storeId: string,
  productId: string,
  quantity: number,
  opts: { reason?: string; source?: string } = {}
): Promise<Record<string, unknown> | null> {
  const level = await first(
    env,
    `SELECT sl.quantity FROM stock_levels sl JOIN products p ON p.id = sl.product_id
     WHERE sl.product_id = ? AND p.store_id = ?`,
    String(productId), String(storeId)
  );
  const current = Number(level?.quantity ?? 0);
  if (!Number.isFinite(Number(quantity))) throw new Error('quantity must be a number');
  return adjustStock(env, storeId, productId, Number(quantity) - current, opts);
}

/** All stock levels for a store, joined with product info. */
export function stockForStore(env: Env, storeId: string) {
  return all(
    env,
    `SELECT p.id AS product_id, p.name, p.sku, p.barcode, c.name AS category_name,
            sl.quantity, sl.reorder_point, sl.updated_at
     FROM products p
     LEFT JOIN stock_levels sl ON sl.product_id = p.id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`,
    String(storeId)
  );
}

/** Recent movements for a store (newest first). */
export function movementsForStore(env: Env, storeId: string, limit = 50) {
  return all(
    env,
    `SELECT m.id, m.product_id, p.name AS product_name, m.delta, m.resulting_quantity,
            m.reason, m.source, m.created_at
     FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE p.store_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    String(storeId),
    Math.max(1, Math.min(Number(limit) || 50, 200))
  );
}

/**
 * Upsert a product by SKU (then barcode, then name) and optionally set its stock.
 * Returns { product, created, level }. Used by CSV sync and the v1 API.
 */
export async function upsertProduct(
  env: Env,
  storeId: string,
  input: Record<string, unknown>,
  { source = 'api' }: { source?: string } = {}
): Promise<{ product: Record<string, unknown>; created: boolean; level: Record<string, unknown> | null } | null> {
  const s = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const sku = s(input.sku, 60);
  const barcode = s(input.barcode, 60);
  const name = s(input.name);
  if (!name && !sku && !barcode) return null;

  let existing: Record<string, unknown> | null = null;
  if (sku) existing = await first(env, 'SELECT * FROM products WHERE store_id = ? AND sku = ?', storeId, sku);
  if (!existing && barcode)
    existing = await first(env, 'SELECT * FROM products WHERE store_id = ? AND barcode = ?', storeId, barcode);
  if (!existing && name && !sku && !barcode)
    existing = await first(env, 'SELECT * FROM products WHERE store_id = ? AND name = ? AND sku = ?', storeId, name, '');

  let product: Record<string, unknown>;
  let created = false;
  if (existing) {
    await run(
      env,
      `UPDATE products SET
         name = COALESCE(NULLIF(?, ''), name),
         brand = COALESCE(NULLIF(?, ''), brand),
         price = ?, updated_at = datetime('now')
       WHERE id = ?`,
      name,
      s(input.brand, 100),
      Number.isFinite(Number(input.price)) && input.price !== null && input.price !== '' ? Number(input.price) : existing.price,
      existing.id
    );
    product = (await first(env, 'SELECT * FROM products WHERE id = ?', existing.id))!;
  } else {
    if (!name) return null;
    const id = newId();
    await run(
      env,
      `INSERT INTO products (id, store_id, name, brand, sku, barcode, price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, storeId, name, s(input.brand, 100), sku, barcode, Number(input.price) || null
    );
    product = (await first(env, 'SELECT * FROM products WHERE id = ?', id))!;
    created = true;
  }

  let level: Record<string, unknown> | null = null;
  if (input.quantity !== undefined && input.quantity !== null && Number.isFinite(Number(input.quantity))) {
    const cur = await first(env, 'SELECT quantity FROM stock_levels WHERE product_id = ?', product.id);
    const q = Number(input.quantity);
    level =
      cur === undefined
        ? await adjustStock(env, storeId, String(product.id), q, { reason: 'import', source })
        : await setStock(env, storeId, String(product.id), q, { reason: 'import', source });
  }
  return { product, created, level };
}

/* ---------------- API keys ---------------- */

export async function hashKey(key: string): Promise<string> {
  return sha256Hex(key);
}

export async function generateApiKey(): Promise<{ key: string; prefix: string }> {
  const secret = randomToken(24).replace(/-/g, '').replace(/_/g, '').slice(0, 48).padEnd(48, '0');
  return { key: `skm_${secret}`, prefix: `skm_${secret.slice(0, 6)}` };
}

/** Resolve an API key to its store, or null. Also stamps last_used_at. */
export async function storeForApiKey(env: Env, rawKey: unknown): Promise<Record<string, unknown> | null> {
  if (typeof rawKey !== 'string' || !rawKey.startsWith('skm_')) return null;
  const row = await first(
    env,
    `SELECT k.id AS key_id, s.* FROM store_api_keys k
     JOIN stores s ON s.id = k.store_id
     WHERE k.key_hash = ? AND k.revoked = 0`,
    await hashKey(rawKey)
  );
  if (!row) return null;
  await run(env, `UPDATE store_api_keys SET last_used_at = datetime('now') WHERE id = ?`, row.key_id);
  return row;
}

/** Extract a key from Authorization: Bearer … or X-API-Key. */
export function keyFromHeaders(authHeader: string | undefined, apiKeyHeader: string | undefined): string | null {
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : null;
}
