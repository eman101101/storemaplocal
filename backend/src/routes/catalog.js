import { Router } from 'express';
import express from 'express';
import { db, newId } from '../db.js';
import { requireAuth } from '../auth/session.js';
import { handler, sendJson, badRequest, rateLimit } from '../lib/http.js';
import { str, num } from '../lib/validate.js';
import { ownedStore, ownedFloor, touchStore } from '../lib/ownership.js';
import { reindexStoreFts } from '../lib/search.js';
import { productImagesEnabled } from '../lib/entitlements.js';
import { saveImage } from '../lib/storage.js';
import { config } from '../config.js';

const router = Router();

const HEX = /^#[0-9a-fA-F]{6}$/;

function productJson(row) {
  return { ...row, price: row.price ?? null };
}

const PRODUCT_JOIN = `SELECT p.*, c.name AS category_name, c.color AS category_color
  FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`;

// ---- Categories ----
router.post('/stores/:storeId/categories', requireAuth, handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.storeId);
  if (!store) return;
  const name = str(req.body?.name, { max: 60, allowEmpty: false });
  if (!name) return badRequest(res, 'Category name is required');
  const color = HEX.test(req.body?.color || '') ? req.body.color : '#4f7d3f';
  const id = newId();
  db.prepare('INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)').run(
    id, store.id, name, color, str(req.body?.icon, { max: 16 })
  );
  sendJson(res, 201, { category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
}));

function ownedCategory(req, res, id) {
  const row = db
    .prepare('SELECT c.*, s.owner_id FROM categories c JOIN stores s ON s.id = c.store_id WHERE c.id = ?')
    .get(String(id));
  if (!row || row.owner_id !== req.user.id) {
    badRequest(res, 'Category not found');
    return null;
  }
  return row;
}

router.patch('/categories/:id', requireAuth, handler(async (req, res) => {
  const cat = ownedCategory(req, res, req.params.id);
  if (!cat) return;
  const updates = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, { max: 60, allowEmpty: false });
    if (!name) return badRequest(res, 'Category name is required');
    updates.name = name;
  }
  if (req.body?.color !== undefined) {
    if (!HEX.test(req.body.color || '')) return badRequest(res, 'Color must be a hex value');
    updates.color = req.body.color;
  }
  if (req.body?.icon !== undefined) updates.icon = str(req.body.icon, { max: 16 });
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE categories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => updates[k]), cat.id
    );
    // Category renames don't fire the products triggers — refresh the store's
    // search index so its products stay findable by the new name.
    if (updates.name !== undefined) reindexStoreFts(db, cat.store_id);
  }
  sendJson(res, 200, { category: db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.id) });
}));

router.delete('/categories/:id', requireAuth, handler(async (req, res) => {
  const cat = ownedCategory(req, res, req.params.id);
  if (!cat) return;
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  reindexStoreFts(db, cat.store_id); // FK ON DELETE SET NULL bypasses triggers
  touchStore(cat.store_id);
  sendJson(res, 200, { ok: true });
}));

// ---- Products ----
router.post('/stores/:storeId/products', requireAuth, handler(async (req, res) => {
  const store = ownedStore(req, res, req.params.storeId);
  if (!store) return;
  const name = str(req.body?.name, { max: 200, allowEmpty: false });
  if (!name) return badRequest(res, 'Product name is required');
  let categoryId = null;
  if (req.body?.category_id) {
    const cat = ownedCategory(req, res, req.body.category_id);
    if (!cat) return;
    categoryId = cat.id;
  }
  let price = null;
  if (req.body?.price !== undefined && req.body?.price !== null && req.body?.price !== '') {
    price = num(req.body.price);
    if (price === undefined || price < 0) return badRequest(res, 'Invalid price');
  }
  const id = newId();
  db.prepare(
    `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, store.id, categoryId, name,
    str(req.body?.brand, { max: 100 }), str(req.body?.sku, { max: 60 }),
    str(req.body?.barcode, { max: 60 }), str(req.body?.description, { max: 1000 }),
    price, str(req.body?.image_url, { max: 400 })
  );
  const product = productJson(db.prepare(PRODUCT_JOIN).get(id));
  touchStore(store.id);
  sendJson(res, 201, { product });
}));

function ownedProduct(req, res, id) {
  const row = db
    .prepare('SELECT p.*, s.owner_id FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = ?')
    .get(String(id));
  if (!row || row.owner_id !== req.user.id) {
    badRequest(res, 'Product not found');
    return null;
  }
  return row;
}

const IMAGE_TYPES = {
  'image/png': { ext: '.png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: '.webp', magic: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

/**
 * POST /api/products/:id/image — raw image bytes; sets products.image_url.
 * Paid-tier feature: enabled on self-hosted (local mode) instances and for
 * stores on the pro plan.
 */
router.post(
  '/products/:id/image',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 30 }),
  express.raw({ type: () => true, limit: '10mb' }),
  handler(async (req, res) => {
    const product = ownedProduct(req, res, req.params.id);
    if (!product) return;
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(product.store_id);
    if (!productImagesEnabled(store)) {
      return sendJson(res, 402, {
        error: 'Product photos are part of the paid plan. Self-hosted (local mode) instances have them included.',
        upgrade: true,
      });
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const spec = IMAGE_TYPES[type];
    if (!spec) return badRequest(res, 'Only PNG, JPEG or WebP images are accepted');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return badRequest(res, 'Empty upload');
    if (buf.length > config.maxUploadBytes) return badRequest(res, 'Image exceeds 10 MB limit');
    if (!spec.magic(buf)) return badRequest(res, 'File content does not match its image type');

    const { url } = await saveImage(buf, spec.ext);
    db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(url, product.id);
    touchStore(product.store_id);
    sendJson(res, 200, { url, product: productJson(db.prepare(PRODUCT_JOIN).get(product.id)) });
  })
);

router.delete('/products/:id/image', requireAuth, handler(async (req, res) => {
  const product = ownedProduct(req, res, req.params.id);
  if (!product) return;
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(product.store_id);
  if (!productImagesEnabled(store)) return sendJson(res, 402, { error: 'Product photos are a paid feature', upgrade: true });
  db.prepare('UPDATE products SET image_url = "" WHERE id = ?').run(product.id);
  touchStore(product.store_id);
  sendJson(res, 200, { ok: true });
}));

router.patch('/products/:id', requireAuth, handler(async (req, res) => {
  const product = ownedProduct(req, res, req.params.id);
  if (!product) return;
  const updates = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, { max: 200, allowEmpty: false });
    if (!name) return badRequest(res, 'Product name is required');
    updates.name = name;
  }
  for (const field of ['brand', 'sku', 'barcode', 'description', 'image_url']) {
    if (req.body?.[field] !== undefined) updates[field] = str(req.body[field], { max: 1000 });
  }
  if (req.body?.price !== undefined) {
    if (req.body.price === null || req.body.price === '') {
      updates.price = null;
    } else {
      const price = num(req.body.price);
      if (price === undefined || price < 0) return badRequest(res, 'Invalid price');
      updates.price = price;
    }
  }
  if (req.body?.category_id !== undefined) {
    if (!req.body.category_id) {
      updates.category_id = null;
    } else {
      const cat = ownedCategory(req, res, req.body.category_id);
      if (!cat) return;
      updates.category_id = cat.id;
    }
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    touchStore(product.store_id);
    db.prepare(
      `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).run(...keys.map((k) => updates[k]), product.id);
  }
  sendJson(res, 200, { product: productJson(db.prepare(PRODUCT_JOIN).get(product.id)) });
}));

router.delete('/products/:id', requireAuth, handler(async (req, res) => {
  const product = ownedProduct(req, res, req.params.id);
  if (!product) return;
  db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
  touchStore(product.store_id);
  sendJson(res, 200, { ok: true });
}));

// ---- Product locations (pins on the map) ----
router.post('/products/:id/locations', requireAuth, handler(async (req, res) => {
  const product = ownedProduct(req, res, req.params.id);
  if (!product) return;
  const floor = req.body?.floor_id ? ownedFloor(req, res, req.body.floor_id) : null;
  if (!floor) return badRequest(res, 'floor_id is required');
  const x = num(req.body?.x);
  const y = num(req.body?.y);
  if (x === undefined || y === undefined) return badRequest(res, 'x and y are required');
  // One pin per product per floor: moving it updates the existing pin.
  const existing = db
    .prepare('SELECT * FROM product_locations WHERE product_id = ? AND floor_id = ?')
    .get(product.id, floor.id);
  const rot = num(req.body?.rot) ?? 0;
  if (existing) {
    db.prepare('UPDATE product_locations SET x = ?, y = ?, rot = ? WHERE id = ?').run(x, y, rot, existing.id);
    var id = existing.id;
  } else {
    id = newId();
    db.prepare('INSERT INTO product_locations (id, product_id, floor_id, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, product.id, floor.id, x, y, rot
    );
  }
  sendJson(res, 201, { location: db.prepare('SELECT * FROM product_locations WHERE id = ?').get(id) });
}));

router.delete('/locations/:id', requireAuth, handler(async (req, res) => {
  const row = db
    .prepare(`SELECT l.*, s.owner_id FROM product_locations l
              JOIN products p ON p.id = l.product_id
              JOIN stores s ON s.id = p.store_id WHERE l.id = ?`)
    .get(String(req.params.id));
  if (!row || row.owner_id !== req.user.id) return badRequest(res, 'Location not found');
  db.prepare('DELETE FROM product_locations WHERE id = ?').run(row.id);
  sendJson(res, 200, { ok: true });
}));

export default router;
