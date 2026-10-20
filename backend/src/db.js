import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const MIGRATIONS = [
  {
    name: '001_initial_schema',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL CHECK (provider IN ('google','apple','dev')),
        provider_sub TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE stores (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        address TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        website TEXT NOT NULL DEFAULT '',
        hours TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_stores_owner ON stores(owner_id);

      CREATE TABLE floors (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Main floor',
        level INTEGER NOT NULL DEFAULT 1,
        width_m REAL NOT NULL DEFAULT 40,
        height_m REAL NOT NULL DEFAULT 30,
        background_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_floors_store ON floors(store_id);

      CREATE TABLE map_elements (
        id TEXT PRIMARY KEY,
        floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('wall','shelf','aisle','zone','entrance','exit','poi')),
        shape TEXT NOT NULL CHECK (shape IN ('rect','polygon','polyline','point')),
        geometry TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        z_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_elements_floor ON map_elements(floor_id);

      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#4f7d3f',
        icon TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_categories_store ON categories(store_id);

      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT '',
        sku TEXT NOT NULL DEFAULT '',
        barcode TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        price REAL,
        image_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_products_store ON products(store_id);

      CREATE TABLE product_locations (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
        x REAL NOT NULL,
        y REAL NOT NULL,
        rot REAL NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_locations_product ON product_locations(product_id);
      CREATE INDEX idx_locations_floor ON product_locations(floor_id);
    `,
  },
  {
    name: '002_stock_tracking_and_integrations',
    sql: `
      CREATE TABLE store_api_keys (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_api_keys_store ON store_api_keys(store_id);

      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        credentials TEXT NOT NULL DEFAULT '{}',
        config TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (store_id, provider)
      );
      CREATE INDEX idx_integrations_store ON integrations(store_id);

      CREATE TABLE stock_levels (
        product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        quantity REAL NOT NULL DEFAULT 0,
        reorder_point REAL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE stock_movements (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        delta REAL NOT NULL,
        resulting_quantity REAL NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_movements_product ON stock_movements(product_id);
    `,
  },
  {
    name: '003-floor-snapshots',
    sql: `
      CREATE TABLE floor_snapshots (
        id TEXT PRIMARY KEY,
        floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
        elements TEXT NOT NULL,
        element_count INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_snapshots_floor ON floor_snapshots(floor_id, created_at_ms DESC);
    `,
  },
  {
    name: '004-store-geo-views',
    sql: `
      ALTER TABLE stores ADD COLUMN lat REAL;
      ALTER TABLE stores ADD COLUMN lng REAL;
      ALTER TABLE stores ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '005-store-plan',
    sql: `
      ALTER TABLE stores ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
    `,
  },
  {
    // Full-text search index (docs/INFRASTRUCTURE.md — search cost at scale):
    // LIKE '%q%' scans a store's whole catalog per keystroke; FTS5 serves the
    // same queries from an inverted index. Kept in sync by triggers; category
    // renames are handled by lib/search.js's reindexStoreFts (FK ON DELETE
    // SET NULL actions bypass UPDATE triggers).
    name: '006-product-search-fts',
    sql: `
      CREATE VIRTUAL TABLE products_fts USING fts5(
        name, brand, sku, barcode, category_name,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
        SELECT p.rowid, p.name, p.brand, p.sku, p.barcode, COALESCE(c.name, '')
        FROM products p LEFT JOIN categories c ON c.id = p.category_id;

      CREATE TRIGGER products_fts_ins AFTER INSERT ON products BEGIN
        INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
        VALUES (new.rowid, new.name, new.brand, new.sku, new.barcode,
          COALESCE((SELECT name FROM categories WHERE id = new.category_id), ''));
      END;

      CREATE TRIGGER products_fts_upd AFTER UPDATE OF name, brand, sku, barcode, category_id ON products BEGIN
        DELETE FROM products_fts WHERE rowid = old.rowid;
        INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
          VALUES (new.rowid, new.name, new.brand, new.sku, new.barcode,
            COALESCE((SELECT name FROM categories WHERE id = new.category_id), ''));
      END;

      CREATE TRIGGER products_fts_del AFTER DELETE ON products BEGIN
        DELETE FROM products_fts WHERE rowid = old.rowid;
      END;
    `,
  },
];

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const applied = new Set(db.prepare('SELECT name FROM migrations').all().map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function newId() {
  return crypto.randomUUID();
}
