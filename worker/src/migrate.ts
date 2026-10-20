/**
 * Schema migrations + first-boot bootstrap (ports of backend/src/db.js and the
 * auto-seed branch of index.js). Runs once per isolate; guarded so concurrent
 * cold starts can't double-apply.
 */
import type { Env } from './config';
import { all, count, first, run } from './db';
import { randomToken } from './util';
import { seedDemoMaps } from './seed';

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL CHECK (provider IN ('google','apple','dev')),
        provider_sub TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS stores (
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
      CREATE INDEX IF NOT EXISTS idx_stores_owner ON stores(owner_id);
      CREATE TABLE IF NOT EXISTS floors (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Main floor',
        level INTEGER NOT NULL DEFAULT 1,
        width_m REAL NOT NULL DEFAULT 40,
        height_m REAL NOT NULL DEFAULT 30,
        background_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_floors_store ON floors(store_id);
      CREATE TABLE IF NOT EXISTS map_elements (
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
      CREATE INDEX IF NOT EXISTS idx_elements_floor ON map_elements(floor_id);
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#4f7d3f',
        icon TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_categories_store ON categories(store_id);
      CREATE TABLE IF NOT EXISTS products (
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
      CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
      CREATE TABLE IF NOT EXISTS product_locations (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
        x REAL NOT NULL,
        y REAL NOT NULL,
        rot REAL NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_locations_product ON product_locations(product_id);
      CREATE INDEX IF NOT EXISTS idx_locations_floor ON product_locations(floor_id);
    `,
  },
  {
    name: '002_stock_tracking_and_integrations',
    sql: `
      CREATE TABLE IF NOT EXISTS store_api_keys (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_store ON store_api_keys(store_id);
      CREATE TABLE IF NOT EXISTS stock_levels (
        product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
        quantity REAL NOT NULL DEFAULT 0,
        reorder_point REAL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        delta REAL NOT NULL,
        resulting_quantity REAL NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
    `,
  },
  {
    name: '003-floor-snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS floor_snapshots (
        id TEXT PRIMARY KEY,
        floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
        elements TEXT NOT NULL,
        element_count INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_floor ON floor_snapshots(floor_id, created_at_ms DESC);
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
    name: '006-app-settings',
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    name: '007-r2-budget',
    sql: `
      CREATE TABLE IF NOT EXISTS r2_budget (
        day TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    // Full-text search index — same as the Node backend's migration 006.
    // Rowid-based triggers stay correct through FK SET NULL and cascades.
    name: '008-product-search-fts',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
        name, brand, sku, barcode, category_name,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
        SELECT p.rowid, p.name, p.brand, p.sku, p.barcode, COALESCE(c.name, '')
        FROM products p LEFT JOIN categories c ON c.id = p.category_id;

      CREATE TRIGGER IF NOT EXISTS products_fts_ins AFTER INSERT ON products BEGIN
        INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
        VALUES (new.rowid, new.name, new.brand, new.sku, new.barcode,
          COALESCE((SELECT name FROM categories WHERE id = new.category_id), ''));
      END;

      CREATE TRIGGER IF NOT EXISTS products_fts_upd AFTER UPDATE OF name, brand, sku, barcode, category_id ON products BEGIN
        DELETE FROM products_fts WHERE rowid = old.rowid;
        INSERT INTO products_fts (rowid, name, brand, sku, barcode, category_name)
        VALUES (new.rowid, new.name, new.brand, new.sku, new.barcode,
          COALESCE((SELECT name FROM categories WHERE id = new.category_id), ''));
      END;

      CREATE TRIGGER IF NOT EXISTS products_fts_del AFTER DELETE ON products BEGIN
        DELETE FROM products_fts WHERE rowid = old.rowid;
      END;
    `,
  },
];

/**
 * Split a migration's SQL into statements. Triggers (BEGIN…END blocks) contain
 * semicolons internally, so a naive ';' split truncates them — accumulate
 * until BEGIN/END keywords balance instead.
 */
function splitStatements(sql: string): string[] {
  const parts = sql.split(';');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    const cand = cur ? `${cur};${parts[i]}` : parts[i];
    const begins = (cand.match(/\bBEGIN\b/g) || []).length;
    const ends = (cand.match(/\bEND\b/g) || []).length;
    if (begins > 0 ? ends >= begins : true) {
      out.push(cand);
      cur = '';
    } else {
      cur = cand;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Apply pending migrations; memoised per isolate. */
export async function migrate(env: Env): Promise<void> {
  if ((migrate as any).done) return;
  (migrate as any).done = (async () => {
    await run(
      env,
      `CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`
    );
    const applied = new Set((await all(env, 'SELECT name FROM migrations')).map((r) => r.name as string));
    for (const m of MIGRATIONS) {
      if (applied.has(m.name)) continue;
      // ALTER TABLE can't run inside a D1 batch with other DDL; statements run
      // one by one — each migration is idempotent via IF NOT EXISTS / its guard.
      try {
        for (const statement of splitStatements(m.sql)) {
          await run(env, statement);
        }
        await run(env, 'INSERT INTO migrations (name) VALUES (?)', m.name);
      } catch (err) {
        // 004/005 ALTERs fail if another cold start applied them first — accept.
        const msg = String((err as Error).message || '');
        if (!/duplicate column|already exists/i.test(msg)) throw err;
        await run(env, 'INSERT OR IGNORE INTO migrations (name) VALUES (?)', m.name);
      }
    }
  })();
  return (migrate as any).done;
}

/** Get (or lazily create + persist) the session-signing secret. */
async function resolveSessionSecret(env: Env): Promise<string> {
  const row = await first(env, "SELECT value FROM app_settings WHERE key = 'session_secret'");
  if (row) return row.value as string;
  const secret = randomToken(48);
  await run(env, "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('session_secret', ?)", secret);
  const stored = await first(env, "SELECT value FROM app_settings WHERE key = 'session_secret'");
  return (stored?.value as string) || secret;
}

/**
 * Full first-boot bootstrap: migrations, session secret, and (in local mode,
 * when the database is empty) the demo maps — the same behavior as the Node
 * backend's SELF_HOSTED=true boot. Resolves with the session secret.
 */
export async function bootstrap(env: Env, selfHosted: boolean): Promise<string> {
  if ((bootstrap as any).done) return (bootstrap as any).done;
  (bootstrap as any).done = (async () => {
    await migrate(env);
    const secret = await resolveSessionSecret(env);
    if (selfHosted && (await count(env, 'SELECT COUNT(*) AS n FROM stores')) === 0) {
      try {
        await seedDemoMaps(env);
      } catch (err) {
        // A concurrent cold start may have seeded first — unique slugs make the
        // second run fail harmlessly.
        console.error('[boot] demo seed failed (likely already seeded):', (err as Error).message);
      }
    }
    return secret;
  })();
  return (bootstrap as any).done;
}
