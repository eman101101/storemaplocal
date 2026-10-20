import { config } from '../config.js';
import express, { Router } from 'express';
import { db, newId } from '../db.js';
import { geocode } from '../lib/geocode.js';
import { requireAuth } from '../auth/session.js';
import { handler, sendJson, badRequest, slugify } from '../lib/http.js';
import { str, num } from '../lib/validate.js';
import { ownedStore, touchStore } from '../lib/ownership.js';
import { entitlementsFor } from '../lib/entitlements.js';
import { buildExportBundle, importBundle, TransferError } from '../lib/transfer.js';

const router = Router();
router.use(requireAuth);

function uniqueSlug(name) {
  const base = slugify(name);
  if (!db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(candidate)) return candidate;
  }
  return `${base}-${newId().slice(0, 8)}`;
}

const EDITABLE_FIELDS = ['name', 'address', 'description', 'phone', 'website', 'hours', 'logo_url'];

function storeJson(row) {
  return {
    ...row,
    is_public: Boolean(row.is_public),
    plan: row.plan || 'free',
    entitlements: entitlementsFor(row),
    // canonical public link — QR codes must encode THIS url, not window.origin
    // (an iframe/phishing host could otherwise mint codes to its own domain)
    shareUrl: `${config.publicBaseUrl}/s/${row.slug}`,
  };
}

// ---- Store CRUD ----
router.get('/mine', handler(async (req, res) => {
  const rows = db
    .prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM floors f WHERE f.store_id = s.id) AS floor_count,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count
      FROM stores s WHERE s.owner_id = ? ORDER BY s.created_at DESC`)
    .all(req.user.id);
  sendJson(res, 200, { stores: rows.map(storeJson) });
}));

/**
 * GET /api/stores/:id/export — self-contained transfer bundle (online ↔
 * local). `?media=0` skips embedding images for a small metadata-only file.
 */
router.get('/:id/export', requireAuth, handler(async (req, res) => {
  const store = await ownedStore(req, res, req.params.id);
  if (!store) return;
  const bundle = buildExportBundle(store, { withMedia: req.query.media !== '0' });
  res.setHeader('Content-Disposition', `attachment; filename="${store.slug}-storemap.json"`);
  sendJson(res, 200, bundle);
}));

/**
 * POST /api/stores/import — restore an export bundle as a new draft store
 * owned by the importer. Larger body limit than the API default: bundles
 * embed product images.
 */
router.post('/import', requireAuth, express.json({ limit: '64mb' }), handler(async (req, res) => {
  try {
    const { storeId } = await importBundle(req.body, req.user.id, { uniqueSlug });
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
    sendJson(res, 201, { store: storeJson(store) });
  } catch (err) {
    if (err instanceof TransferError) return badRequest(res, err.message);
    throw err;
  }
}));

router.post('/', handler(async (req, res) => {
  const name = str(req.body?.name, { max: 100, allowEmpty: false });
  if (!name) return badRequest(res, 'Store name is required');
  const id = newId();
  db.prepare(
    `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.user.id, name, uniqueSlug(name),
    str(req.body?.address, { max: 300 }), str(req.body?.description, { max: 1000 }),
    str(req.body?.phone, { max: 40 }), str(req.body?.website, { max: 300 }), str(req.body?.hours, { max: 300 })
  );
  // Every store starts with one floor so the editor opens ready to draw.
  db.prepare('INSERT INTO floors (id, store_id, name, level) VALUES (?, ?, ?, ?)').run(
    newId(), id, 'Main floor', 1
  );
  maybeGeocode(id, req.body?.address);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  sendJson(res, 201, { store: storeJson(store) });
}));

router.get('/:id/full', handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.id);
  if (!store) return;
  // ETag: editors reopen stores constantly — unchanged data answers 304.
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM floors WHERE store_id = ?) f,
              (SELECT COUNT(*) FROM map_elements me JOIN floors fl ON fl.id = me.floor_id WHERE fl.store_id = ?) e,
              (SELECT COUNT(*) FROM products WHERE store_id = ?) p,
              (SELECT COUNT(*) FROM product_locations pl JOIN products pr ON pr.id = pl.product_id WHERE pr.store_id = ?) l`
    )
    .get(store.id, store.id, store.id, store.id);
  const etag = `"v1-${store.updated_at}-${counts.f}-${counts.e}-${counts.p}-${counts.l}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('ETag', etag);
  const floors = db.prepare('SELECT * FROM floors WHERE store_id = ? ORDER BY level ASC, created_at ASC').all(store.id);
  const floorIds = floors.map((f) => f.id);
  const elements = floorIds.length
    ? db.prepare(
        `SELECT * FROM map_elements WHERE floor_id IN (${floorIds.map(() => '?').join(',')})
         ORDER BY z_index ASC, rowid ASC`
      ).all(...floorIds)
    : [];
  const categories = db.prepare('SELECT * FROM categories WHERE store_id = ? ORDER BY name').all(store.id);
  const products = db
    .prepare(`SELECT p.*, c.name AS category_name, c.color AS category_color
              FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE p.store_id = ? ORDER BY p.name COLLATE NOCASE`)
    .all(store.id);
  const locations = floorIds.length
    ? db.prepare(
        `SELECT l.* FROM product_locations l
         JOIN products p ON p.id = l.product_id
         WHERE p.store_id = ?`
      ).all(store.id)
    : [];
  sendJson(res, 200, {
    store: storeJson(store),
    floors,
    elements,
    categories,
    products,
    locations,
  });
}));

router.patch('/:id', handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.id);
  if (!store) return;
  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (req.body?.[field] !== undefined) {
      const v = str(req.body[field], { max: 1000 });
      if (v === undefined) return badRequest(res, `Invalid value for ${field}`);
      updates[field] = v;
    }
  }
  if (req.body?.is_public !== undefined) {
    updates.is_public = req.body.is_public ? 1 : 0;
  }
  // Plan changes are self-serve in local mode; hosted instances get them from billing.
  if (req.body?.plan !== undefined) {
    if (!config.selfHosted) return sendJson(res, 402, { error: 'Plan changes are managed by billing on hosted instances' });
    const plan = String(req.body.plan);
    if (!['free', 'pro'].includes(plan)) return badRequest(res, 'Invalid plan');
    updates.plan = plan;
  }
  // Note: slug intentionally stays stable after creation so public links never break.
  const keys = Object.keys(updates);
  if (keys.length) {
    touchStore(store.id);
    db.prepare(`UPDATE stores SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => updates[k]), store.id
    );
  }
  sendJson(res, 200, { store: storeJson(db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id)) });
}));

router.delete('/:id', handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.id);
  if (!store) return;
  db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
  sendJson(res, 200, { ok: true });
}));

// ---- Floors ----
router.post('/:id/floors', handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.id);
  if (!store) return;
  const name = str(req.body?.name, { max: 80 }) || `Floor ${db.prepare('SELECT COUNT(*) c FROM floors WHERE store_id = ?').get(store.id).c + 1}`;
  const width = num(req.body?.width_m) ?? 40;
  const height = num(req.body?.height_m) ?? 30;
  const level = num(req.body?.level) ?? db.prepare('SELECT COALESCE(MAX(level),0)+1 n FROM floors WHERE store_id = ?').get(store.id).n;
  const id = newId();
  db.prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, store.id, name, level, width, height
  );
  sendJson(res, 201, { floor: db.prepare('SELECT * FROM floors WHERE id = ?').get(id) });
}));

/** Best-effort address→lat/lng (env-gated so tests never touch the network). */
function maybeGeocode(storeId, address) {
  if (process.env.STOREMAP_GEOCODE !== 'true') return;
  geocode(address)
    .then((hit) => {
      if (hit) db.prepare('UPDATE stores SET lat = ?, lng = ? WHERE id = ?').run(hit.lat, hit.lng, storeId);
    })
    .catch(() => {});
}

/**
 * POST /api/stores/:id/duplicate — clone a store with floors, elements,
 * categories, products and pins (media URLs keep working: they're immutable).
 * Publish state is NOT copied — clones start as drafts.
 */
router.post('/:id/duplicate', handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.id);
  if (!store) return;
  const name = str(req.body?.name, { max: 100, allowEmpty: false }) || `${store.name} (copy)`;
  const cloneId = newId();
  const idMap = new Map(); // old id → new id across every cloned table
  const remap = (v) => idMap.get(v) ?? v;

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours, logo_url, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cloneId, req.user.id, name, uniqueSlug(name), store.address, store.description,
      store.phone, store.website, store.hours, store.logo_url, store.lat, store.lng
    );
    const floors = db.prepare('SELECT * FROM floors WHERE store_id = ? ORDER BY level').all(store.id);
    for (const f of floors) {
      const fid = newId();
      idMap.set(f.id, fid);
      db.prepare(
        `INSERT INTO floors (id, store_id, name, level, width_m, height_m, background_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(fid, cloneId, f.name, f.level, f.width_m, f.height_m, f.background_url);
      for (const e of db.prepare('SELECT * FROM map_elements WHERE floor_id = ?').all(f.id)) {
        const eid = newId();
        idMap.set(e.id, eid);
        db.prepare(
          `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(eid, fid, e.type, e.shape, e.geometry, e.label, e.color, e.meta, e.z_index);
      }
    }
    for (const c of db.prepare('SELECT * FROM categories WHERE store_id = ?').all(store.id)) {
      const cid = newId();
      idMap.set(c.id, cid);
      db.prepare('INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)')
        .run(cid, cloneId, c.name, c.color, c.icon);
    }
    for (const pr of db.prepare('SELECT * FROM products WHERE store_id = ?').all(store.id)) {
      const pid = newId();
      idMap.set(pr.id, pid);
      db.prepare(
        `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pid, cloneId, remap(pr.category_id), pr.name, pr.brand, pr.sku, pr.barcode, pr.description, pr.price, pr.image_url);
      for (const l of db.prepare('SELECT * FROM product_locations WHERE product_id = ?').all(pr.id)) {
        db.prepare(
          `INSERT INTO product_locations (id, product_id, floor_id, x, y, rot, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(newId(), pid, remap(l.floor_id), l.x, l.y, l.rot, l.meta);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  sendJson(res, 201, { store: storeJson(db.prepare('SELECT * FROM stores WHERE id = ?').get(cloneId)) });
}));

export default router;
