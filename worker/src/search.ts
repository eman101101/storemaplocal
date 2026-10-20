/** FTS5 search helpers for the worker (mirror of backend/src/lib/search.js). */
import type { Env } from './config';
import { run } from './db';

/** Build an FTS5 MATCH expression from free-text input; null = not searchable. */
export function ftsExpression(input: unknown): string | null {
  const tokens = String(input || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/**
 * Reindex one store's products after a category rename/delete (FK SET NULL
 * bypasses the product triggers, so index rows would keep the old name).
 */
export async function reindexStoreFts(env: Env, storeId: string): Promise<void> {
  await run(env, 'DELETE FROM products_fts WHERE rowid IN (SELECT rowid FROM products WHERE store_id = ?)', storeId);
  await run(
    env,
    `INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
     SELECT p.rowid, p.name, p.brand, p.sku, p.barcode, COALESCE(c.name, '')
     FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.store_id = ?`,
    storeId
  );
}
