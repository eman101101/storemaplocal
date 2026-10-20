/** Catalog routes: categories, products, product images, pins (port of catalog.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run } from '../db';
import { newId } from '../util';
import { json, badRequest, rateLimit } from '../http';
import { str, num } from '../validate';
import { ownedStore, ownedFloor, touchStore } from '../ownership';
import { productImagesEnabled } from '../entitlements';
import { saveImage } from '../storage';
import { reindexStoreFts } from '../search';

const app = new Hono<AppEnv>();

const HEX = /^#[0-9a-fA-F]{6}$/;

function productJson(row: Record<string, unknown>) {
  return { ...row, price: row.price ?? null };
}

const PRODUCT_JOIN = `SELECT p.*, c.name AS category_name, c.color AS category_color
  FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`;

async function requireAuth(c: any, next: () => Promise<void>) {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
}

async function ownedCategory(c: any, env: Env, id: unknown): Promise<Record<string, unknown> | Response> {
  const row = await first(
    env,
    'SELECT c.*, s.owner_id FROM categories c JOIN stores s ON s.id = c.store_id WHERE c.id = ?',
    String(id)
  );
  if (!row || row.owner_id !== c.get('user').id) return badRequest(c, 'Category not found');
  return row;
}

async function ownedProduct(c: any, env: Env, id: unknown): Promise<Record<string, unknown> | Response> {
  const row = await first(
    env,
    'SELECT p.*, s.owner_id FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = ?',
    String(id)
  );
  if (!row || row.owner_id !== c.get('user').id) return badRequest(c, 'Product not found');
  return row;
}

/* ---- Categories ---- */

app.post('/stores/:storeId/categories', requireAuth, async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body?.name, { max: 60, allowEmpty: false });
  if (!name) return badRequest(c, 'Category name is required');
  const color = HEX.test(body?.color || '') ? body.color : '#4f7d3f';
  const id = newId();
  await run(env, 'INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)', id, store.id, name, color, str(body?.icon, { max: 16 }));
  return json(c, 201, { category: await first(env, 'SELECT * FROM categories WHERE id = ?', id) });
});

app.patch('/categories/:id', requireAuth, async (c) => {
  const env = c.env as Env;
  const cat = await ownedCategory(c, env, c.req.param('id'));
  if (cat instanceof Response) return cat;
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = str(body.name, { max: 60, allowEmpty: false });
    if (!name) return badRequest(c, 'Category name is required');
    updates.name = name;
  }
  if (body?.color !== undefined) {
    if (!HEX.test(body.color || '')) return badRequest(c, 'Color must be a hex value');
    updates.color = body.color;
  }
  if (body?.icon !== undefined) updates.icon = str(body.icon, { max: 16 });
  const keys = Object.keys(updates);
  if (keys.length) {
    await run(env, `UPDATE categories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), cat.id);
    // Category renames don't fire the product triggers — refresh the search index.
    if (updates.name !== undefined) await reindexStoreFts(env, cat.store_id as string);
  }
  return json(c, 200, { category: await first(env, 'SELECT * FROM categories WHERE id = ?', cat.id) });
});

app.delete('/categories/:id', requireAuth, async (c) => {
  const env = c.env as Env;
  const cat = await ownedCategory(c, env, c.req.param('id'));
  if (cat instanceof Response) return cat;
  await run(env, 'DELETE FROM categories WHERE id = ?', cat.id);
  await reindexStoreFts(env, cat.store_id as string); // FK SET NULL bypasses triggers
  await touchStore(env, cat.store_id as string);
  return json(c, 200, { ok: true });
});

/* ---- Products ---- */

app.post('/stores/:storeId/products', requireAuth, async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body?.name, { max: 200, allowEmpty: false });
  if (!name) return badRequest(c, 'Product name is required');
  let categoryId: string | null = null;
  if (body?.category_id) {
    const cat = await ownedCategory(c, env, body.category_id);
    if (cat instanceof Response) return cat;
    categoryId = cat.id as string;
  }
  let price: number | null = null;
  if (body?.price !== undefined && body?.price !== null && body?.price !== '') {
    price = num(body.price)!;
    if (price === undefined || price < 0) return badRequest(c, 'Invalid price');
  }
  const id = newId();
  await run(
    env,
    `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, store.id, categoryId, name,
    str(body?.brand, { max: 100 }), str(body?.sku, { max: 60 }),
    str(body?.barcode, { max: 60 }), str(body?.description, { max: 1000 }),
    price, str(body?.image_url, { max: 400 })
  );
  const product = productJson((await first(env, PRODUCT_JOIN, id))!);
  await touchStore(env, store.id);
  return json(c, 201, { product });
});

const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/png': { ext: '.png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': {
    ext: '.webp',
    magic: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
};

const imageLimiter = rateLimit({ windowMs: 60_000, max: 30 });

app.post('/products/:id/image', requireAuth, imageLimiter, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  const product = await ownedProduct(c, env, c.req.param('id'));
  if (product instanceof Response) return product;
  const store = await first(env, 'SELECT * FROM stores WHERE id = ?', product.store_id);
  if (!productImagesEnabled(cfg, store as { plan?: string })) {
    return json(c, 402, {
      error: 'Product photos are part of the paid plan. Self-hosted (local mode) instances have them included.',
      upgrade: true,
    });
  }
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  const spec = IMAGE_TYPES[type];
  if (!spec) return badRequest(c, 'Only PNG, JPEG or WebP images are accepted');
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.length) return badRequest(c, 'Empty upload');
  if (buf.length > cfg.maxUploadBytes) return badRequest(c, 'Image exceeds 10 MB limit');
  if (!spec.magic(buf)) return badRequest(c, 'File content does not match its image type');

  let url: string;
  try {
    ({ url } = await saveImage(env, buf, spec.ext));
  } catch (err) {
    if ((err as Error).message === 'R2_DAILY_BUDGET_REACHED')
      return json(c, 503, { error: 'Daily media budget reached — uploads pause until tomorrow.', retry: true });
    throw err;
  }
  await run(env, 'UPDATE products SET image_url = ? WHERE id = ?', url, product.id);
  await touchStore(env, product.store_id as string);
  return json(c, 200, { url, product: productJson((await first(env, PRODUCT_JOIN, product.id))!) });
});

app.delete('/products/:id/image', requireAuth, async (c) => {
  const env = c.env as Env;
  const cfg = c.get('config');
  const product = await ownedProduct(c, env, c.req.param('id'));
  if (product instanceof Response) return product;
  const store = await first(env, 'SELECT * FROM stores WHERE id = ?', product.store_id);
  if (!productImagesEnabled(cfg, store as { plan?: string }))
    return json(c, 402, { error: 'Product photos are a paid feature', upgrade: true });
  await run(env, 'UPDATE products SET image_url = "" WHERE id = ?', product.id);
  await touchStore(env, product.store_id as string);
  return json(c, 200, { ok: true });
});

app.patch('/products/:id', requireAuth, async (c) => {
  const env = c.env as Env;
  const product = await ownedProduct(c, env, c.req.param('id'));
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = str(body.name, { max: 200, allowEmpty: false });
    if (!name) return badRequest(c, 'Product name is required');
    updates.name = name;
  }
  for (const field of ['brand', 'sku', 'barcode', 'description', 'image_url']) {
    if (body?.[field] !== undefined) updates[field] = str(body[field], { max: 1000 });
  }
  if (body?.price !== undefined) {
    if (body.price === null || body.price === '') {
      updates.price = null;
    } else {
      const price = num(body.price);
      if (price === undefined || price < 0) return badRequest(c, 'Invalid price');
      updates.price = price;
    }
  }
  if (body?.category_id !== undefined) {
    if (!body.category_id) {
      updates.category_id = null;
    } else {
      const cat = await ownedCategory(c, env, body.category_id);
      if (cat instanceof Response) return cat;
      updates.category_id = cat.id;
    }
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    await touchStore(env, product.store_id as string);
    await run(
      env,
      `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => updates[k]),
      product.id
    );
  }
  return json(c, 200, { product: productJson((await first(env, PRODUCT_JOIN, product.id))!) });
});

app.delete('/products/:id', requireAuth, async (c) => {
  const env = c.env as Env;
  const product = await ownedProduct(c, env, c.req.param('id'));
  if (product instanceof Response) return product;
  await run(env, 'DELETE FROM products WHERE id = ?', product.id);
  await touchStore(env, product.store_id as string);
  return json(c, 200, { ok: true });
});

/* ---- Product locations (pins on the map) ---- */

app.post('/products/:id/locations', requireAuth, async (c) => {
  const env = c.env as Env;
  const product = await ownedProduct(c, env, c.req.param('id'));
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  const floor = body?.floor_id ? await ownedFloor(c, env, body.floor_id) : null;
  if (floor instanceof Response) return floor;
  if (!floor) return badRequest(c, 'floor_id is required');
  const x = num(body?.x);
  const y = num(body?.y);
  if (x === undefined || y === undefined) return badRequest(c, 'x and y are required');
  // One pin per product per floor: moving it updates the existing pin.
  const existing = await first(env, 'SELECT * FROM product_locations WHERE product_id = ? AND floor_id = ?', product.id, floor.id);
  const rot = num(body?.rot) ?? 0;
  let id: string;
  if (existing) {
    await run(env, 'UPDATE product_locations SET x = ?, y = ?, rot = ? WHERE id = ?', x, y, rot, existing.id);
    id = existing.id as string;
  } else {
    id = newId();
    await run(env, 'INSERT INTO product_locations (id, product_id, floor_id, x, y, rot) VALUES (?, ?, ?, ?, ?, ?)', id, product.id, floor.id, x, y, rot);
  }
  return json(c, 201, { location: await first(env, 'SELECT * FROM product_locations WHERE id = ?', id) });
});

app.delete('/locations/:id', requireAuth, async (c) => {
  const env = c.env as Env;
  const row = await first(
    env,
    `SELECT l.*, s.owner_id FROM product_locations l
     JOIN products p ON p.id = l.product_id
     JOIN stores s ON s.id = p.store_id WHERE l.id = ?`,
    String(c.req.param('id'))
  );
  if (!row || row.owner_id !== c.get('user').id) return badRequest(c, 'Location not found');
  await run(env, 'DELETE FROM product_locations WHERE id = ?', row.id);
  return json(c, 200, { ok: true });
});

export default app;
