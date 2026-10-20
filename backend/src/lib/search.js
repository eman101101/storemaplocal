/**
 * FTS5 search helpers (migration 006 keeps products_fts in sync via triggers).
 * Search terms are matched as word-prefixes against the inverted index —
 * 'mil' finds 'milk' — instead of LIKE '%q%' scans of the whole catalog.
 */

/** Build an FTS5 MATCH expression from free-text input; null = not searchable. */
export function ftsExpression(input) {
  const tokens = String(input || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/**
 * Reindex one store's products after a category rename/delete. FK ON DELETE
 * SET NULL actions bypass UPDATE triggers, so the FTS rows would keep the old
 * category name — rewrite the store's index rows instead (a few thousand rows
 * on a rare admin action).
 */
export function reindexStoreFts(db, storeId) {
  db.prepare('DELETE FROM products_fts WHERE rowid IN (SELECT rowid FROM products WHERE store_id = ?)').run(storeId);
  db.prepare(
    `INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
     SELECT p.rowid, p.name, p.brand, p.sku, p.barcode, COALESCE(c.name, '')
     FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.store_id = ?`
  ).run(storeId);
}
