/**
 * Store transfer — export a store as a self-contained bundle and import it
 * into another StoreMap instance (online ↔ local). Both engines share the
 * same schema, so the bundle is plain data with index-based cross-references;
 * media is embedded base64 so the file moves alone.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, newId } from '../db.js';
import { config } from '../config.js';
import { saveImage } from './storage.js';
import { validateElement } from './validate.js';

export const EXPORT_FORMAT = 'storemap.export/1';

/** Safety caps for imports — a transfer, not a bulk-migration tool. */
const LIMITS = { floors: 30, elements: 20_000, categories: 500, products: 20_000, locations: 40_000, mediaFiles: 2_000, mediaBytes: 60 * 1024 * 1024 };

const internalPath = (u) => (typeof u === 'string' && u.startsWith('/uploads/') ? u : null);

/** Read an uploaded image's bytes from local disk (export side). */
function readLocalMedia(p) {
  const name = path.basename(p);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = path.join(config.uploadsDir, name);
  if (!fs.existsSync(file)) return null;
  return { ext: path.extname(name).toLowerCase(), buf: fs.readFileSync(file) };
}

/**
 * Build the export bundle for an owned store. `withMedia` embeds referenced
 * images (/uploads/…) as base64 so the destination instance owns its copies.
 */
export function buildExportBundle(store, { withMedia = true } = {}) {
  const floors = db.prepare('SELECT * FROM floors WHERE store_id = ? ORDER BY level, created_at').all(store.id);
  const floorIndex = new Map(floors.map((f, i) => [f.id, i]));
  const elements = floors.flatMap((f) =>
    db.prepare('SELECT * FROM map_elements WHERE floor_id = ? ORDER BY z_index, rowid').all(f.id)
  );
  const categories = db.prepare('SELECT * FROM categories WHERE store_id = ? ORDER BY name').all(store.id);
  const catIndex = new Map(categories.map((c, i) => [c.id, i]));
  const products = db
    .prepare('SELECT * FROM products WHERE store_id = ? ORDER BY name COLLATE NOCASE')
    .all(store.id);
  const prodIndex = new Map(products.map((p, i) => [p.id, i]));
  const locations = db
    .prepare(
      `SELECT l.* FROM product_locations l JOIN products p ON p.id = l.product_id WHERE p.store_id = ?`
    )
    .all(store.id);
  const stock = db
    .prepare(
      `SELECT sl.product_id, sl.quantity, sl.reorder_point FROM stock_levels sl
       JOIN products p ON p.id = sl.product_id WHERE p.store_id = ?`
    )
    .all(store.id);

  const media = [];
  const mediaByPath = new Map();
  const embed = (p) => {
    if (!withMedia || mediaByPath.has(p)) return;
    const file = readLocalMedia(p);
    mediaByPath.set(p, null); // missing files export as a dangling path, not an error
    if (file) {
      mediaByPath.set(p, media.length);
      media.push({ path: p, ext: file.ext, data: file.buf.toString('base64') });
    }
  };
  for (const p of products) if (internalPath(p.image_url)) embed(p.image_url);
  for (const f of floors) if (internalPath(f.background_url)) embed(f.background_url);
  if (internalPath(store.logo_url)) embed(store.logo_url);

  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    store: {
      name: store.name,
      address: store.address,
      description: store.description,
      phone: store.phone,
      website: store.website,
      hours: store.hours,
      logo_url: store.logo_url,
      lat: store.lat,
      lng: store.lng,
    },
    floors: floors.map((f) => ({
      name: f.name, level: f.level, width_m: f.width_m, height_m: f.height_m, background_url: f.background_url,
    })),
    categories: categories.map((c) => ({ name: c.name, color: c.color, icon: c.icon })),
    products: products.map((p) => ({
      name: p.name, brand: p.brand, sku: p.sku, barcode: p.barcode,
      description: p.description, price: p.price, image_url: p.image_url,
      category: p.category_id != null ? catIndex.get(p.category_id) : null,
    })),
    elements: elements.map((e) => ({
      floor: floorIndex.get(e.floor_id), type: e.type, shape: e.shape, geometry: e.geometry,
      label: e.label, color: e.color, meta: e.meta, z_index: e.z_index,
    })),
    locations: locations.map((l) => ({
      product: prodIndex.get(l.product_id), floor: floorIndex.get(l.floor_id),
      x: l.x, y: l.y, rot: l.rot,
    })),
    stock: stock.map((s) => ({
      product: prodIndex.get(s.product_id), quantity: s.quantity, reorder_point: s.reorder_point,
    })),
    media,
  };
}

/**
 * Import a bundle as a NEW store owned by `userId`. All rows get fresh ids;
 * embedded media is re-saved through the destination's storage (new paths,
 * URLs rewritten). Imports always start as a private draft. Runs in one
 * transaction — a bad bundle leaves nothing behind.
 */
export async function importBundle(bundle, userId, { uniqueSlug }) {
  if (!bundle || bundle.format !== EXPORT_FORMAT || !Array.isArray(bundle.floors)) {
    throw new TransferError('Not a StoreMap export file');
  }
  const s = bundle.store || {};
  const name = String(s.name || 'Imported store').slice(0, 100);
  for (const [key, max] of Object.entries(LIMITS)) {
    const list = bundle[key] || [];
    if (list.length > max) throw new TransferError(`Export too large: ${key} (${list.length} > ${max})`);
  }

  // Restore media first (outside the transaction): new paths, best-effort —
  // R2-budget or disk failures skip an image, they don't kill the transfer.
  const urlRewrite = new Map();
  let mediaRestored = 0;
  let mediaBytes = 0;
  for (const m of bundle.media || []) {
    if (!m?.path || typeof m.data !== 'string') continue;
    mediaBytes += (m.data.length * 3) / 4;
    if (mediaBytes > LIMITS.mediaBytes) throw new TransferError('Export too large: media');
    try {
      const buf = Buffer.from(m.data, 'base64');
      const ext = typeof m.ext === 'string' && /^\.(png|jpe?g|webp)$/.test(m.ext) ? m.ext : '.png';
      const { url } = await saveImage(buf, ext);
      urlRewrite.set(m.path, url);
      mediaRestored += 1;
    } catch {
      /* skip this image */
    }
  }
  // rewritten media path → new local path; un-restorable internal paths are
  // dropped (a dangling /uploads reference would 404 on the other instance);
  // external URLs pass through untouched.
  const rewrite = (u) => {
    if (typeof u !== 'string' || !u) return '';
    if (urlRewrite.has(u)) return urlRewrite.get(u);
    return internalPath(u) ? '' : u;
  };

  const storeId = newId();
  const floorIds = [];
  const catIds = [];
  const prodIds = [];

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours, logo_url, lat, lng, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      storeId, userId, name, uniqueSlug(name),
      String(s.address || '').slice(0, 300), String(s.description || '').slice(0, 1000),
      String(s.phone || '').slice(0, 40), String(s.website || '').slice(0, 300), String(s.hours || '').slice(0, 300),
      rewrite(s.logo_url) || '',
      Number.isFinite(s.lat) ? s.lat : null, Number.isFinite(s.lng) ? s.lng : null
    );

    for (const f of bundle.floors) {
      const id = newId();
      floorIds.push(id);
      db.prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m, background_url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, storeId, String(f.name || 'Floor').slice(0, 80),
        Number.isFinite(f.level) ? f.level : floorIds.length,
        Number.isFinite(f.width_m) ? f.width_m : 40, Number.isFinite(f.height_m) ? f.height_m : 30,
        rewrite(f.background_url) || ''
      );
    }

    for (const c of bundle.categories || []) {
      const id = newId();
      catIds.push(id);
      db.prepare('INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)').run(
        id, storeId, String(c.name || 'Category').slice(0, 60),
        /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : '#4f7d3f', String(c.icon || '').slice(0, 16)
      );
    }

    const insProd = db.prepare(
      `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of bundle.products || []) {
      const id = newId();
      prodIds.push(id);
      const catIdx = Number.isInteger(p.category) ? p.category : null;
      insProd.run(
        id, storeId,
        catIdx != null && catIdx >= 0 && catIdx < catIds.length ? catIds[catIdx] : null,
        String(p.name || 'Product').slice(0, 200), String(p.brand || '').slice(0, 100),
        String(p.sku || '').slice(0, 60), String(p.barcode || '').slice(0, 60),
        String(p.description || '').slice(0, 1000),
        Number.isFinite(p.price) && p.price >= 0 ? p.price : null,
        rewrite(p.image_url) || ''
      );
    }

    for (const e of bundle.elements || []) {
      const fidx = Number.isInteger(e.floor) ? e.floor : -1;
      if (fidx < 0 || fidx >= floorIds.length) continue;
      const row = validateElement(e);
      if (!row) continue;
      db.prepare(
        `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), floorIds[fidx], row.type, row.shape, row.geometry, row.label, row.color, row.meta, row.z_index);
    }

    const insLoc = db.prepare(
      'INSERT INTO product_locations (id, product_id, floor_id, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const l of bundle.locations || []) {
      const pidx = Number.isInteger(l.product) ? l.product : -1;
      const fidx = Number.isInteger(l.floor) ? l.floor : -1;
      if (pidx < 0 || pidx >= prodIds.length || fidx < 0 || fidx >= floorIds.length) continue;
      if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
      insLoc.run(newId(), prodIds[pidx], floorIds[fidx], l.x, l.y, Number.isFinite(l.rot) ? l.rot : 0);
    }

    for (const st of bundle.stock || []) {
      const pidx = Number.isInteger(st.product) ? st.product : -1;
      if (pidx < 0 || pidx >= prodIds.length || !Number.isFinite(st.quantity)) continue;
      db.prepare(
        `INSERT INTO stock_levels (product_id, quantity, reorder_point) VALUES (?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET quantity = excluded.quantity`
      ).run(prodIds[pidx], st.quantity, Number.isFinite(st.reorder_point) ? st.reorder_point : null);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { storeId, mediaRestored };
}

export class TransferError extends Error {}
