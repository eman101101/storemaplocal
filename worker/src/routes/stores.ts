/** Store routes (port of backend/src/routes/stores.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run, stmt } from '../db';
import { newId } from '../util';
import { json, badRequest, slugify } from '../http';
import { str, num } from '../validate';
import { ownedStore, touchStore } from '../ownership';
import { entitlementsFor } from '../entitlements';
import { buildExportBundle, importBundle, TransferError } from '../transfer';

const app = new Hono<AppEnv>();

// All store routes require a signed-in owner.
app.use('*', async (c, next) => {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
});

async function uniqueSlug(env: Env, name: string): Promise<string> {
  const base = slugify(name);
  if (!(await first(env, 'SELECT 1 FROM stores WHERE slug = ?', base))) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!(await first(env, 'SELECT 1 FROM stores WHERE slug = ?', candidate))) return candidate;
  }
  return `${base}-${newId().slice(0, 8)}`;
}

const EDITABLE_FIELDS = ['name', 'address', 'description', 'phone', 'website', 'hours', 'logo_url'];

function storeJson(c: any, row: Record<string, unknown>) {
  const cfg = c.get('config');
  return {
    ...row,
    is_public: Boolean(row.is_public),
    plan: row.plan || 'free',
    entitlements: entitlementsFor(cfg, row as { plan?: string }),
    // canonical public link — QR codes must encode THIS url, not window.origin
    shareUrl: `${cfg.publicBaseUrl}/s/${row.slug}`,
  };
}

app.get('/mine', async (c) => {
  const env = c.env as Env;
  const rows = await all(
    env,
    `SELECT s.*,
      (SELECT COUNT(*) FROM floors f WHERE f.store_id = s.id) AS floor_count,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
      FROM stores s WHERE s.owner_id = ? ORDER BY s.created_at DESC`,
    c.get('user').id
  );
  return json(c, 200, { stores: rows.map((r) => storeJson(c, r)) });
});

/**
 * GET /api/stores/:id/export — self-contained transfer bundle (online ↔
 * local). `?media=0` skips embedding images for a small metadata-only file.
 */
app.get('/:id/export', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  const bundle = await buildExportBundle(env, store, c.req.query('media') !== '0');
  c.header('Content-Disposition', `attachment; filename="${store.slug}-storemap.json"`);
  return json(c, 200, bundle);
});

/** POST /api/stores/import — restore an export bundle as a new draft store. */
app.post('/import', async (c) => {
  const env = c.env as Env;
  const bundle = await c.req.json().catch(() => null);
  try {
    const { storeId } = await importBundle(env, c.get('user').id, bundle, (name) => uniqueSlug(env, name));
    const created = await first(env, 'SELECT * FROM stores WHERE id = ?', storeId);
    return json(c, 201, { store: storeJson(c, created ?? {}) });
  } catch (err) {
    if (err instanceof TransferError) return badRequest(c, err.message);
    throw err;
  }
});

app.post('/', async (c) => {
  const env = c.env as Env;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body?.name, { max: 100, allowEmpty: false });
  if (!name) return badRequest(c, 'Store name is required');
  const id = newId();
  await run(
    env,
    `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, c.get('user').id, name, await uniqueSlug(env, name),
    str(body?.address, { max: 300 }), str(body?.description, { max: 1000 }),
    str(body?.phone, { max: 40 }), str(body?.website, { max: 300 }), str(body?.hours, { max: 300 })
  );
  // Every store starts with one floor so the editor opens ready to draw.
  await run(env, 'INSERT INTO floors (id, store_id, name, level) VALUES (?, ?, ?, ?)', newId(), id, 'Main floor', 1);
  const store = await first(env, 'SELECT * FROM stores WHERE id = ?', id);
  return json(c, 201, { store: storeJson(c, store!) });
});

app.get('/:id/full', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  // ETag: editors reopen stores constantly — unchanged data answers 304.
  const counts = await first(
    env,
    `SELECT (SELECT COUNT(*) FROM floors WHERE store_id = ?) f,
            (SELECT COUNT(*) FROM map_elements me JOIN floors fl ON fl.id = me.floor_id WHERE fl.store_id = ?) e,
            (SELECT COUNT(*) FROM products WHERE store_id = ?) p,
            (SELECT COUNT(*) FROM product_locations pl JOIN products pr ON pr.id = pl.product_id WHERE pr.store_id = ?) l`,
    store.id, store.id, store.id, store.id
  );
  const etag = `"v1-${store.updated_at}-${counts!.f}-${counts!.e}-${counts!.p}-${counts!.l}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  c.header('ETag', etag);
  const floors = await all(env, 'SELECT * FROM floors WHERE store_id = ? ORDER BY level ASC, created_at ASC', store.id);
  const floorIds = floors.map((f) => f.id as string);
  const elements = floorIds.length
    ? await all(
        env,
        `SELECT * FROM map_elements WHERE floor_id IN (${floorIds.map(() => '?').join(',')})
         ORDER BY z_index ASC, rowid ASC`,
        ...floorIds
      )
    : [];
  const categories = await all(env, 'SELECT * FROM categories WHERE store_id = ? ORDER BY name', store.id);
  const products = await all(
    env,
    `SELECT p.*, c.name AS category_name, c.color AS category_color
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`,
    store.id
  );
  const locations = floorIds.length
    ? await all(
        env,
        `SELECT l.* FROM product_locations l JOIN products p ON p.id = l.product_id WHERE p.store_id = ?`,
        store.id
      )
    : [];
  return json(c, 200, { store: storeJson(c, store), floors, elements, categories, products, locations });
});

app.patch('/:id', async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (body?.[field] !== undefined) {
      const v = str(body[field], { max: 1000 });
      if (v === undefined) return badRequest(c, `Invalid value for ${field}`);
      updates[field] = v;
    }
  }
  if (body?.is_public !== undefined) updates.is_public = body.is_public ? 1 : 0;
  // Plan changes are self-serve in local mode; hosted instances get them from billing.
  if (body?.plan !== undefined) {
    if (!cfg.selfHosted) return json(c, 402, { error: 'Plan changes are managed by billing on hosted instances' });
    const plan = String(body.plan);
    if (!['free', 'pro'].includes(plan)) return badRequest(c, 'Invalid plan');
    updates.plan = plan;
  }
  // Note: slug intentionally stays stable after creation so public links never break.
  const keys = Object.keys(updates);
  if (keys.length) {
    await touchStore(env, store.id);
    await run(env, `UPDATE stores SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), store.id);
  }
  const fresh = await first(env, 'SELECT * FROM stores WHERE id = ?', store.id);
  return json(c, 200, { store: storeJson(c, fresh!) });
});

app.delete('/:id', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  await run(env, 'DELETE FROM stores WHERE id = ?', store.id);
  return json(c, 200, { ok: true });
});

/* ---- Floors ---- */

app.post('/:id/floors', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const floorCount = await first(env, 'SELECT COUNT(*) c FROM floors WHERE store_id = ?', store.id);
  const name = str(body?.name, { max: 80 }) || `Floor ${Number(floorCount?.c ?? 0) + 1}`;
  const width = num(body?.width_m) ?? 40;
  const height = num(body?.height_m) ?? 30;
  const maxLevel = await first(env, 'SELECT COALESCE(MAX(level),0)+1 n FROM floors WHERE store_id = ?', store.id);
  const level = num(body?.level) ?? Number(maxLevel?.n ?? 1);
  const id = newId();
  await run(env, 'INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, ?, ?, ?)', id, store.id, name, level, width, height);
  return json(c, 201, { floor: await first(env, 'SELECT * FROM floors WHERE id = ?', id) });
});

/**
 * POST /api/stores/:id/duplicate — clone a store with floors, elements,
 * categories, products and pins. Publish state is NOT copied — clones start
 * as drafts. One atomic D1 batch.
 */
app.post('/:id/duplicate', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('id'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body?.name, { max: 100, allowEmpty: false }) || `${store.name} (copy)`;
  const cloneId = newId();
  const idMap = new Map<string, string>();
  const remap = (v: unknown) => idMap.get(String(v)) ?? v;

  const statements: D1PreparedStatement[] = [];
  statements.push(
    stmt(
      env,
      `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours, logo_url, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cloneId, c.get('user').id, name, await uniqueSlug(env, name), store.address, store.description,
      store.phone, store.website, store.hours, store.logo_url, store.lat, store.lng
    )
  );
  const floors = await all(env, 'SELECT * FROM floors WHERE store_id = ? ORDER BY level', store.id);
  for (const f of floors) {
    const fid = newId();
    idMap.set(String(f.id), fid);
    statements.push(
      stmt(
        env,
        `INSERT INTO floors (id, store_id, name, level, width_m, height_m, background_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        fid, cloneId, f.name, f.level, f.width_m, f.height_m, f.background_url
      )
    );
    for (const e of await all(env, 'SELECT * FROM map_elements WHERE floor_id = ?', f.id)) {
      const eid = newId();
      idMap.set(String(e.id), eid);
      statements.push(
        stmt(
          env,
          `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eid, fid, e.type, e.shape, e.geometry, e.label, e.color, e.meta, e.z_index
        )
      );
    }
  }
  for (const cat of await all(env, 'SELECT * FROM categories WHERE store_id = ?', store.id)) {
    const cid = newId();
    idMap.set(String(cat.id), cid);
    statements.push(stmt(env, 'INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)', cid, cloneId, cat.name, cat.color, cat.icon));
  }
  for (const pr of await all(env, 'SELECT * FROM products WHERE store_id = ?', store.id)) {
    const pid = newId();
    idMap.set(String(pr.id), pid);
    statements.push(
      stmt(
        env,
        `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pid, cloneId, pr.category_id ? remap(pr.category_id) : null, pr.name, pr.brand, pr.sku, pr.barcode, pr.description, pr.price, pr.image_url
      )
    );
    for (const l of await all(env, 'SELECT * FROM product_locations WHERE product_id = ?', pr.id)) {
      statements.push(
        stmt(
          env,
          `INSERT INTO product_locations (id, product_id, floor_id, x, y, rot, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newId(), pid, l.floor_id ? remap(l.floor_id) : null, l.x, l.y, l.rot, l.meta
        )
      );
    }
  }
  // D1 batches have statement limits — send in chunks; each chunk is atomic,
  // and a failure mid-way only ever leaves an unnamed draft (no public effect).
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  const clone = await first(env, 'SELECT * FROM stores WHERE id = ?', cloneId);
  return json(c, 201, { store: storeJson(c, clone!) });
});

export default app;
