/**
 * Store transfer on the Worker — mirrors backend/src/lib/transfer.js.
 * Export: self-contained bundle with media embedded base64 (read from R2).
 * Import: fresh ids, index-remapped rows, media re-saved through R2 (respect
 * the daily budget), always a private draft, chunked atomic D1 batches.
 */
import type { Env } from './config';
import { all, stmt } from './db';
import { newId } from './util';
import { saveImage } from './storage';
import { validateElement } from './validate';

export const EXPORT_FORMAT = 'storemap.export/1';

const LIMITS = {
  floors: 30,
  elements: 20_000,
  categories: 500,
  products: 20_000,
  locations: 40_000,
  media: 2_000,
};
const MAX_MEDIA_BYTES = 60 * 1024 * 1024;

const internalPath = (u: unknown): string | null =>
  typeof u === 'string' && u.startsWith('/uploads/') ? u : null;

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TransferError extends Error {}

export async function buildExportBundle(env: Env, store: Record<string, unknown>, withMedia = true): Promise<Record<string, unknown>> {
  const floors = await all(env, 'SELECT * FROM floors WHERE store_id = ? ORDER BY level, created_at', store.id);
  const floorIndex = new Map(floors.map((f, i) => [String(f.id), i]));
  const elements: Record<string, unknown>[] = [];
  for (const f of floors) {
    for (const e of await all(env, 'SELECT * FROM map_elements WHERE floor_id = ? ORDER BY z_index, rowid', f.id)) {
      elements.push({ floor: floorIndex.get(String(f.id)), ...e });
    }
  }
  const categories = await all(env, 'SELECT * FROM categories WHERE store_id = ? ORDER BY name', store.id);
  const catIndex = new Map(categories.map((c, i) => [String(c.id), i]));
  const products = await all(env, 'SELECT * FROM products WHERE store_id = ? ORDER BY name COLLATE NOCASE', store.id);
  const prodIndex = new Map(products.map((p, i) => [String(p.id), i]));
  const locations = await all(
    env,
    'SELECT l.* FROM product_locations l JOIN products p ON p.id = l.product_id WHERE p.store_id = ?',
    store.id
  );
  const stock = await all(
    env,
    'SELECT sl.product_id, sl.quantity, sl.reorder_point FROM stock_levels sl JOIN products p ON p.id = sl.product_id WHERE p.store_id = ?',
    store.id
  );

  const media: Record<string, unknown>[] = [];
  const mediaByPath = new Map<string, number>();
  const embed = async (p: string) => {
    if (!withMedia || mediaByPath.has(p)) return;
    mediaByPath.set(p, -1);
    try {
      const name = p.split('/').pop()!;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return;
      const obj = await env.MEDIA.get(`uploads/${name}`);
      if (!obj) return;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      mediaByPath.set(p, media.length);
      media.push({ path: p, ext, data: b64encode(bytes) });
    } catch {
      /* unreadable media exports as a dangling path */
    }
  };
  for (const p of products) if (internalPath(p.image_url)) await embed(p.image_url as string);
  for (const f of floors) if (internalPath(f.background_url)) await embed(f.background_url as string);
  if (internalPath(store.logo_url)) await embed(store.logo_url as string);

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
      category: p.category_id != null ? catIndex.get(String(p.category_id)) ?? null : null,
    })),
    elements: elements.map((e) => ({
      floor: e.floor, type: e.type, shape: e.shape, geometry: e.geometry,
      label: e.label, color: e.color, meta: e.meta, z_index: e.z_index,
    })),
    locations: locations.map((l) => ({
      product: prodIndex.get(String(l.product_id)), floor: floorIndex.get(String(l.floor_id)),
      x: l.x, y: l.y, rot: l.rot,
    })),
    stock: stock.map((s) => ({
      product: prodIndex.get(String(s.product_id)), quantity: s.quantity, reorder_point: s.reorder_point,
    })),
    media,
  };
}

export async function importBundle(
  env: Env,
  userId: string,
  bundle: any,
  uniqueSlug: (name: string) => Promise<string>
): Promise<{ storeId: string }> {
  if (!bundle || bundle.format !== EXPORT_FORMAT || !Array.isArray(bundle.floors)) {
    throw new TransferError('Not a StoreMap export file');
  }
  const s = bundle.store || {};
  const name = String(s.name || 'Imported store').slice(0, 100);
  if ((bundle.floors || []).length > LIMITS.floors) throw new TransferError('Export too large: floors');
  if ((bundle.elements || []).length > LIMITS.elements) throw new TransferError('Export too large: elements');
  if ((bundle.categories || []).length > LIMITS.categories) throw new TransferError('Export too large: categories');
  if ((bundle.products || []).length > LIMITS.products) throw new TransferError('Export too large: products');
  if ((bundle.locations || []).length > LIMITS.locations) throw new TransferError('Export too large: locations');
  if ((bundle.media || []).length > LIMITS.media) throw new TransferError('Export too large: media');

  // Restore media first: new R2 paths, best-effort (budget misses skip a file).
  const urlRewrite = new Map<string, string>();
  let mediaBytes = 0;
  for (const m of bundle.media || []) {
    if (!m?.path || typeof m.data !== 'string') continue;
    mediaBytes += (m.data.length * 3) / 4;
    if (mediaBytes > MAX_MEDIA_BYTES) throw new TransferError('Export too large: media');
    try {
      const ext = typeof m.ext === 'string' && /^\.(png|jpe?g|webp)$/.test(m.ext) ? m.ext : '.png';
      const { url } = await saveImage(env, b64decode(m.data), ext);
      urlRewrite.set(m.path, url);
    } catch {
      /* R2 budget or write failure — skip this image */
    }
  }
  const rewrite = (u: unknown): string => {
    if (typeof u !== 'string' || !u) return '';
    if (urlRewrite.has(u)) return urlRewrite.get(u)!;
    return internalPath(u) ? '' : u;
  };

  const storeId = newId();
  const floorIds: string[] = [];
  const catIds: string[] = [];
  const prodIds: string[] = [];
  const statements: D1PreparedStatement[] = [];

  statements.push(
    stmt(
      env,
      `INSERT INTO stores (id, owner_id, name, slug, address, description, phone, website, hours, logo_url, lat, lng, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      storeId, userId, name, await uniqueSlug(name),
      String(s.address || '').slice(0, 300), String(s.description || '').slice(0, 1000),
      String(s.phone || '').slice(0, 40), String(s.website || '').slice(0, 300), String(s.hours || '').slice(0, 300),
      rewrite(s.logo_url),
      Number.isFinite(s.lat) ? s.lat : null, Number.isFinite(s.lng) ? s.lng : null
    )
  );

  for (const f of bundle.floors) {
    const id = newId();
    floorIds.push(id);
    statements.push(
      stmt(env, 'INSERT INTO floors (id, store_id, name, level, width_m, height_m, background_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, storeId, String(f.name || 'Floor').slice(0, 80),
        Number.isFinite(f.level) ? f.level : floorIds.length,
        Number.isFinite(f.width_m) ? f.width_m : 40, Number.isFinite(f.height_m) ? f.height_m : 30,
        rewrite(f.background_url))
    );
  }

  for (const c of bundle.categories || []) {
    const id = newId();
    catIds.push(id);
    statements.push(
      stmt(env, 'INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)',
        id, storeId, String(c.name || 'Category').slice(0, 60),
        /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : '#4f7d3f', String(c.icon || '').slice(0, 16))
    );
  }

  for (const p of bundle.products || []) {
    const id = newId();
    prodIds.push(id);
    const catIdx = Number.isInteger(p.category) ? p.category : null;
    statements.push(
      stmt(env,
        `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, storeId,
        catIdx != null && catIdx >= 0 && catIdx < catIds.length ? catIds[catIdx] : null,
        String(p.name || 'Product').slice(0, 200), String(p.brand || '').slice(0, 100),
        String(p.sku || '').slice(0, 60), String(p.barcode || '').slice(0, 60),
        String(p.description || '').slice(0, 1000),
        Number.isFinite(p.price) && p.price >= 0 ? p.price : null,
        rewrite(p.image_url))
    );
  }

  for (const e of bundle.elements || []) {
    const fidx = Number.isInteger(e.floor) ? e.floor : -1;
    if (fidx < 0 || fidx >= floorIds.length) continue;
    const row = validateElement(e);
    if (!row) continue;
    statements.push(
      stmt(env,
        `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), floorIds[fidx], row.type, row.shape, row.geometry, row.label, row.color, row.meta, row.z_index)
    );
  }

  for (const l of bundle.locations || []) {
    const pidx = Number.isInteger(l.product) ? l.product : -1;
    const fidx = Number.isInteger(l.floor) ? l.floor : -1;
    if (pidx < 0 || pidx >= prodIds.length || fidx < 0 || fidx >= floorIds.length) continue;
    if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
    statements.push(
      stmt(env, 'INSERT INTO product_locations (id, product_id, floor_id, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)',
        newId(), prodIds[pidx], floorIds[fidx], l.x, l.y, Number.isFinite(l.rot) ? l.rot : 0)
    );
  }

  for (const st of bundle.stock || []) {
    const pidx = Number.isInteger(st.product) ? st.product : -1;
    if (pidx < 0 || pidx >= prodIds.length || !Number.isFinite(st.quantity)) continue;
    statements.push(
      stmt(env,
        `INSERT INTO stock_levels (product_id, quantity, reorder_point) VALUES (?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET quantity = excluded.quantity`,
        prodIds[pidx], st.quantity, Number.isFinite(st.reorder_point) ? st.reorder_point : null)
    );
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return { storeId };
}
