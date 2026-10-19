/**
 * Demo map generator — a faithful port of backend/scripts/seed-demo.mjs to
 * pure row arrays, inserted via D1 batches. Seeds Freshmart Downtown (the
 * 54×36 m supermarket, 150 pinned products) and Annex Market (the complex
 * L-shaped hall + warehouse, 42 products) under the demo owner account that
 * "Open the demo maps" signs into.
 */
import type { Env } from './config';
import { first } from './db';
import { newId } from './util';

interface Face {
  axis: 'h' | 'v';
  line: number;
  from: number;
  to: number;
  hall?: boolean;
}
interface Slot {
  x: number;
  y: number;
  hall?: boolean;
}

/** id, floor_id, type, shape, geometry, label, color, z_index — meta is inlined as '{}' in the SQL. */
type ElemRow = [string, string, string, string, string, string, string, number];
type ProdRow = [string, string, string | null, string, string, string, string, string, number, string];
type LocRow = [string, string, string, number, number];

const ELEMENT_SQL = `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index)
  VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`;
const PRODUCT_SQL = `INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const LOCATION_SQL = `INSERT INTO product_locations (id, product_id, floor_id, x, y, rot, meta) VALUES (?, ?, ?, ?, ?, 0, '{}')`;

/** Chunk statements — D1 batches stay comfortably within limits. */
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertAll(env: Env, sql: string, rows: unknown[][]): Promise<void> {
  for (const chunk of chunks(rows, 40)) {
    await env.DB.batch(chunk.map((r) => env.DB.prepare(sql).bind(...r)));
  }
}

/** Create (or reuse) the demo owner account; returns its id. */
async function ensureDemoOwner(env: Env): Promise<string> {
  const owner = await first(env, "SELECT id FROM users WHERE email = 'annex@storemap.demo'");
  if (owner) return owner.id as string;
  const uid = newId();
  await env.DB
    .prepare("INSERT INTO users (id, email, name, provider, provider_sub) VALUES (?, ?, ?, 'dev', ?)")
    .bind(uid, 'annex@storemap.demo', 'Demo Map Owner', 'demo-owner')
    .run();
  return uid;
}

async function ensureStore(
  env: Env,
  ownerId: string,
  opts: { slug: string; name: string; address: string; description: string; hours: string; floorName: string; w: number; h: number }
): Promise<{ id: string; floorId: string }> {
  let store = await first(env, 'SELECT id FROM stores WHERE slug = ?', opts.slug);
  if (!store) {
    const sid = newId();
    await env.DB
      .prepare(
        `INSERT INTO stores (id, owner_id, name, slug, address, description, hours, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(sid, ownerId, opts.name, opts.slug, opts.address, opts.description, opts.hours)
      .run();
    store = { id: sid };
  }
  let floor = await first(env, 'SELECT id FROM floors WHERE store_id = ? ORDER BY level LIMIT 1', store.id);
  if (!floor) {
    const fid = newId();
    await env.DB
      .prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(fid, store.id, opts.floorName, opts.w, opts.h)
      .run();
    floor = { id: fid };
  }
  return { id: store.id as string, floorId: floor.id as string };
}

/* ════════════════ Freshmart Downtown ════════════════ */

const W = 54;
const H = 36;

const CATS: [string, string, string, number, string[]][] = [
  ['Dairy', '#3b6fd4', '🥛', 20, [
    'Organic Whole Milk 1L', 'Semi-Skimmed Milk 2L', 'Oat Drink Barista 1L', 'Greek Yogurt 500g',
    'Natural Yogurt 4-pack', 'Strawberry Yogurt 6-pack', 'Kefir 1L', 'Salted Butter 250g',
    'Unsalted Butter 250g', 'Mild Cheddar Block 350g', 'Mature Cheddar Block 350g', 'Mozzarella Ball 125g',
    'Feta Cheese 200g', 'Cream Cheese Tub 300g', 'Cottage Cheese 250g', 'Double Cream 500ml',
    'Crème Fraîche 250ml', 'Brie Wheel 200g', 'Gouda Slices 200g', 'Lactose-Free Milk 1L',
  ]],
  ['Produce', '#2f9e44', '🥬', 20, [
    'Bananas (bunch)', 'Fuji Apples 4-pack', 'Granny Smith Apples 6-pack', 'Navel Oranges 2kg Bag',
    'Clementines 1kg', 'Lemons 4-pack', 'Strawberries 400g', 'Blueberries 150g',
    'Raspberries 150g', 'Seedless Grapes 500g', 'Avocados (2-pack)', 'Baby Spinach 120g',
    'Rocket Salad 100g', 'Roma Tomatoes 500g', 'Cherry Tomatoes 250g', 'Cucumbers (3-pack)',
    'Red Bell Peppers (3-pack)', 'Broccoli Head', 'Carrots 1kg Bag', 'Russet Potatoes 2kg Bag',
  ]],
  ['Beverages', '#e4572e', '🧃', 18, [
    'Orange Juice 1L', 'Apple Juice 1L', 'Sparkling Water 6×500ml', 'Still Water 6×1.5L',
    'Cola 2L', 'Lemon-Lime Soda 2L', 'Ginger Beer 4-pack', 'Iced Tea Lemon 1.5L',
    'Cold Brew Coffee 1L', 'Ground Coffee 500g', 'Espresso Beans 1kg', 'Green Tea 40 Bags',
    'English Breakfast Tea 80 Bags', 'Hot Chocolate Mix 400g', 'Energy Drink 4-pack', 'Tonic Water 6-pack',
    'Almond Milk 1L', 'Coconut Water 1L',
  ]],
  ['Snacks', '#d4a017', '🍿', 18, [
    'Sea Salt Crisps 150g', 'Salt & Vinegar Crisps 150g', 'Tortilla Chips 300g', 'Salsa Dip 300g',
    'Salted Peanuts 200g', 'Roasted Cashews 200g', 'Mixed Nuts 300g', 'Sweet Popcorn 100g',
    'Milk Chocolate Bar 100g', 'Dark Chocolate 70% 100g', 'Choc Chip Cookies 300g', 'Oat Raisin Cookies 250g',
    'Digestive Biscuits 400g', 'Jaffa Cakes 12-pack', 'Cereal Bar 6-pack', 'Salted Pretzels 250g',
    'Rice Cakes 150g', 'Gummy Bears 200g',
  ]],
  ['Bakery', '#c47f17', '🥖', 15, [
    'Sourdough Loaf', 'Wholemeal Loaf 800g', 'Multiseed Bloomer', 'Baguettes (2-pack)',
    'Croissants 4-pack', 'Pain au Chocolat 4-pack', 'Blueberry Muffins 4-pack', 'Cinnamon Rolls 4-pack',
    'Bagels 6-pack', 'Tortilla Wraps 8-pack', 'Pita Breads 6-pack', 'Garlic Ciabatta',
    'Brioche Buns 6-pack', 'Chelsea Buns 6-pack', 'Doughnuts 5-pack',
  ]],
  ['Frozen', '#7c3aed', '🧊', 15, [
    'Frozen Pepperoni Pizza', 'Frozen Margherita Pizza', 'Frozen Berry Mix 500g', 'Garden Peas 1kg',
    'Sweetcorn 1kg', 'French Fries 1.5kg', 'Vanilla Ice Cream 1L', 'Chocolate Ice Cream 1L',
    'Salted Caramel Ice Cream 500ml', 'Fish Fingers 20-pack', 'King Prawns 400g', 'Frozen Salmon Fillets 2-pack',
    'Chicken Nuggets 750g', 'Veg Spring Rolls 8-pack', 'Frozen Waffles 10-pack',
  ]],
  ['Household', '#3a7ca5', '🧻', 22, [
    'Kitchen Roll 4 Rolls', 'Bath Tissue 9 Rolls', 'Bin Bags 30L 20-pack', 'Washing Up Liquid 500ml',
    'Laundry Pods 30-pack', 'Fabric Softener 1.5L', 'Antibacterial Spray 750ml', 'Glass Cleaner 500ml',
    'Bleach 750ml', 'Sponges 6-pack', 'Scourer Pads 4-pack', 'Dishwasher Tablets 40-pack',
    'Trash Bags 60L 15-pack', 'Aluminum Foil 30m', 'Cling Film 30m', 'Baking Paper 25m',
    'Air Freshener 300ml', 'Hand Soap 500ml', 'Shower Cleaner 750ml', 'Furniture Polish 300ml',
    'Light Bulbs 4-pack', 'Batteries AA 8-pack',
  ]],
  ['Meat & Seafood', '#b0413e', '🥩', 22, [
    'Chicken Breast Fillets 1kg', 'Chicken Thighs 750g', 'Whole Chicken 1.6kg', 'Beef Mince 500g',
    'Pork Mince 500g', 'Ribeye Steak 300g', 'Sirloin Steak 300g', 'Lamb Chops 400g',
    'Pork Loin Chops 6-pack', 'Bacon Rashers 300g', 'Streaky Bacon 200g', 'Pork Sausages 8-pack',
    'Chorizo Ring 250g', 'Honey-Roast Ham 200g', 'Turkey Slices 150g', 'Salmon Fillets 2-pack',
    'Cod Fillets 2-pack', 'Tuna Steaks 2-pack', 'Peeled Prawns 200g', 'Smoked Salmon 180g',
    'Mackerel Fillets 240g', 'Sea Bass Fillets 2-pack',
  ]],
];

const BRANDS = ['Fresh Farm', 'GreenVale', 'Sun Grove', 'Meadow', 'Olympus', 'Stone Oven', 'Napoli', 'Glacier', 'Nord Haus', 'Terra'];

async function seedFreshmart(env: Env, ownerId: string): Promise<void> {
  const { id: storeId, floorId } = await ensureStore(env, ownerId, {
    slug: 'freshmart-downtown',
    name: 'Freshmart Downtown',
    address: '400 Main St',
    description:
      'The full-size supermarket demo: perimeter wall shelving, double-sided gondola aisles, checkout by the entrance.',
    hours: '8am–10pm daily',
    floorName: 'Main floor',
    w: W,
    h: H,
  });

  const shelfCount = await first(
    env,
    "SELECT COUNT(*) AS n FROM map_elements WHERE floor_id = ? AND type = 'shelf'",
    floorId
  );
  if (Number(shelfCount?.n ?? 0) >= 6) return; // already present — idempotent

  const elements: ElemRow[] = [];
  let z = 1;
  const rect = (type: string, x: number, y: number, w: number, h: number, label = '') =>
    elements.push([newId(), floorId, type, 'rect', JSON.stringify({ x, y, w, h, rot: 0 }), label, '', z++]);
  const point = (type: string, x: number, y: number, label = '') =>
    elements.push([newId(), floorId, type, 'point', JSON.stringify({ x, y }), label, '', z++]);

  rect('wall', 0, 0, W, 0.4, 'North wall');
  rect('wall', 0, H - 0.4, W, 0.4, 'South wall');
  rect('wall', 0, 0, 0.4, H, 'West wall');
  rect('wall', W - 0.4, 0, 0.4, H, 'East wall');
  point('entrance', 27, H - 0.9, 'Entrance');
  point('exit', 31, H - 0.9, 'Exit');
  rect('zone', 20, 29.6, 14, 3.2);
  for (let i = 0; i < 4; i++) rect('shelf', 21.3 + i * 3.4, 30.3, 2.3, 1.3, `Checkout ${i + 1}`);
  point('poi', 48.5, 33.2, 'Customer service');
  point('poi', 2.2, 28.5, 'Restrooms');

  rect('shelf', 0.55, 2, 1.1, 31.35, 'West wall');
  rect('shelf', 2, 0.55, W - 4.15, 1.1, 'North wall');
  rect('shelf', W - 1.65, 2, 1.1, 31.35, 'East wall');
  rect('shelf', 2, H - 1.65, 17, 1.1, 'South wall');
  rect('shelf', 35, H - 1.65, 17, 1.1, 'South wall');

  const SEGMENTS: [number, number][] = [[6, 19], [28, 19]];
  const faces: Face[] = [];
  for (let p = 0; p < 4; p++) {
    const y0 = 6 + p * 6;
    const label = `Aisle ${p + 1}`;
    for (const [x0, len] of SEGMENTS) {
      rect('shelf', x0, y0, len, 0.7, label);
      rect('shelf', x0, y0 + 2.2, len, 0.7, label);
      faces.push({ axis: 'h', line: y0, from: x0 + 0.4, to: x0 + len - 0.4 });
      faces.push({ axis: 'h', line: y0 + 0.7, from: x0 + 0.4, to: x0 + len - 0.4 });
      faces.push({ axis: 'h', line: y0 + 2.2, from: x0 + 0.4, to: x0 + len - 0.4 });
      faces.push({ axis: 'h', line: y0 + 2.9, from: x0 + 0.4, to: x0 + len - 0.4 });
    }
  }
  faces.push({ axis: 'v', line: 1.65, from: 2.6, to: H - 2.9 });
  faces.push({ axis: 'h', line: 1.65, from: 2.6, to: W - 2.6 });
  faces.push({ axis: 'v', line: W - 1.65, from: 2.6, to: H - 2.9 });
  faces.push({ axis: 'h', line: H - 1.65, from: 2.6, to: 18.8 });
  faces.push({ axis: 'h', line: H - 1.65, from: 35.2, to: W - 2.6 });

  const products: { name: string; category: string }[] = [];
  const catIds: Record<string, string> = {};
  const catRows: unknown[][] = [];
  for (const [name, color, icon, , items] of CATS) {
    const existing = await first(env, 'SELECT id FROM categories WHERE store_id = ? AND name = ?', storeId, name);
    const id = (existing?.id as string) ?? newId();
    if (!existing) catRows.push([id, storeId, name, color, icon]);
    catIds[name] = id;
    for (const item of items) products.push({ name: item, category: name });
  }

  const slots: Slot[] = [];
  for (const f of faces) {
    const len = f.to - f.from;
    const n = Math.max(1, Math.floor(len / 2.2));
    for (let i = 0; i < n; i++) {
      const at = f.from + ((i + 0.5) * len) / n;
      slots.push(f.axis === 'h' ? { x: at, y: f.line } : { x: f.line, y: at });
    }
  }
  const total = slots.length;
  const take = Math.min(products.length, 150);
  const prodRows: ProdRow[] = [];
  const locRows: LocRow[] = [];
  for (let i = 0; i < take; i++) {
    const slot = slots[Math.min(total - 1, Math.round((i * total) / take))];
    const p = products[i];
    const pid = newId();
    const price = Math.round((0.79 + ((i * 37) % 920) / 100) * 100) / 100;
    prodRows.push([
      pid, storeId, catIds[p.category], p.name, BRANDS[i % BRANDS.length],
      `${p.category.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`, '', '', price, '',
    ]);
    locRows.push([newId(), pid, floorId, slot.x, slot.y]);
  }

  await insertAll(env, ELEMENT_SQL, elements);
  await insertAll(env, 'INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)', catRows);
  await insertAll(env, PRODUCT_SQL, prodRows);
  await insertAll(env, LOCATION_SQL, locRows);
}

/* ════════════════ Annex Market ════════════════ */

const AW = 48;
const AH = 46;

const ACATS: [string, string, string, string[]][] = [
  ['Dairy', '#3b6fd4', '🥛', ['Whole Milk 1L', 'Butter 250g', 'Cheddar 350g', 'Greek Yogurt 500g', 'Oat Milk 1L', 'Brie 200g']],
  ['Produce', '#2f9e44', '🥬', ['Bananas', 'Apples 4-pack', 'Rocket 100g', 'Tomatoes 500g', 'Avocados 2-pack', 'Carrots 1kg']],
  ['Snacks', '#d4a017', '🍿', ['Sea Salt Crisps', 'Tortilla Chips', 'Milk Chocolate', 'Cookies 300g', 'Pretzels', 'Popcorn']],
  ['Household', '#3a7ca5', '🧻', ['Kitchen Roll', 'Laundry Pods', 'Bin Bags', 'Washing Up Liquid', 'Bleach', 'Sponges']],
  ['Seasonal', '#e4572e', '🎃', ['Pumpkin', 'Fairy Lights', 'Gift Wrap', 'Candles', 'Wreath', 'Advent Calendar']],
  ['Hardware', '#7950f2', '🔧', ['Duct Tape', 'Batteries AA', 'Light Bulbs', 'Extension Lead', 'Screwdriver Set', 'Work Gloves']],
  ['Bulk', '#c47f17', '📦', ['Rice 10kg', 'Flour 5kg', 'Olive Oil 5L', 'Detergent 10L', 'Dog Food 12kg', 'Cat Litter 10L']],
];

async function seedAnnex(env: Env, ownerId: string): Promise<void> {
  const { id: storeId, floorId } = await ensureStore(env, ownerId, {
    slug: 'annex-market',
    name: 'Annex Market',
    address: '12 Harbour Rd',
    description: 'Complex-shape example: L-shaped hall with a loading-dock notch and an attached backstock warehouse.',
    hours: '7am-11pm daily',
    floorName: 'Main + Warehouse',
    w: AW,
    h: AH,
  });

  const shelfRow = await first(
    env,
    "SELECT COUNT(*) AS n FROM map_elements WHERE floor_id = ? AND type = 'shelf'",
    floorId
  );
  if (Number(shelfRow?.n ?? 0) > 0) return;

  const elements: ElemRow[] = [];
  let az = 1;
  const arect = (type: string, x: number, y: number, w: number, h: number, label = '') =>
    elements.push([newId(), floorId, type, 'rect', JSON.stringify({ x, y, w, h, rot: 0 }), label, '', az++]);
  const apoly = (type: string, pts: number[][], label = '') =>
    elements.push([newId(), floorId, type, 'polyline', JSON.stringify(pts.map((p) => [p[0], p[1]])), label, '', az++]);
  const apoint = (type: string, x: number, y: number, label = '') =>
    elements.push([newId(), floorId, type, 'point', JSON.stringify({ x, y }), label, '', az++]);

  apoly('wall', [[0, 0], [32, 0], [32, 8], [48, 8], [48, 46], [32, 46], [32, 34], [0, 34], [0, 0]], 'Outer walls');
  apoly('wall', [[32, 34], [38, 34]], 'Hall / warehouse');
  apoly('wall', [[41, 34], [48, 34]], 'Hall / warehouse');
  apoint('entrance', 6, 32.8, 'Entrance');
  apoint('exit', 26, 32.8, 'Exit');
  arect('zone', 2.5, 27.5, 13, 5, 'Checkout');
  for (let i = 0; i < 3; i++) arect('shelf', 4 + i * 4, 28.6, 2.6, 1.2, `Checkout ${i + 1}`);
  apoint('poi', 44.5, 3.5, 'Loading dock');
  arect('zone', 33, 1, 14, 6);

  arect('shelf', 0.55, 2.5, 1.1, 30, 'West wall');
  arect('shelf', 2, 0.55, 28, 1.1, 'North wall');
  const afaces: Face[] = [];
  afaces.push({ axis: 'v', line: 1.65, from: 3, to: 31 });
  afaces.push({ axis: 'h', line: 1.65, from: 3, to: 28 });
  for (let p = 0; p < 4; p++) {
    const y0 = 4.5 + p * 5.6;
    const label = `Aisle ${p + 1}`;
    arect('shelf', 3.5, y0, 24, 0.7, label);
    arect('shelf', 3.5, y0 + 2.2, 24, 0.7, label);
    apoly('aisle', [[4, y0 + 1.45], [27, y0 + 1.45]], label);
    for (const line of [y0, y0 + 0.7, y0 + 2.2, y0 + 2.9]) afaces.push({ axis: 'h', line, from: 4, to: 27 });
  }

  arect('zone', 33.2, 9.2, 14.6, 23.8, 'Seasonal');
  for (let v = 0; v < 2; v++) {
    const x0 = 35.2 + v * 6.4;
    const label = `Aisle ${5 + v}`;
    arect('shelf', x0, 10, 0.7, 21, label);
    arect('shelf', x0 + 2.7, 10, 0.7, 21, label);
    apoly('aisle', [[x0 + 1.7, 11], [x0 + 1.7, 30]], label);
    for (const line of [x0, x0 + 0.7, x0 + 2.7, x0 + 3.4]) afaces.push({ axis: 'v', line, from: 11, to: 30 });
  }

  arect('zone', 32.6, 34.6, 14.8, 10.8, 'Backstock');
  apoly('aisle', [[35, 40], [45, 40]], 'Rack row');
  for (let r = 0; r < 3; r++) {
    const x = 34.2 + r * 4.4;
    arect('shelf', x, 36.2, 1.3, 7.6, `Rack ${r + 1}`);
    afaces.push({ axis: 'v', line: x + 0.05, from: 36.6, to: 43.4 });
    afaces.push({ axis: 'v', line: x + 1.25, from: 36.6, to: 43.4 });
  }
  apoint('poi', 39.5, 44.9, 'Receiving');

  const aproducts: { name: string; category: string }[] = [];
  const acat: Record<string, string> = {};
  const catRows: unknown[][] = [];
  for (const [name, color, icon, items] of ACATS) {
    const cid = newId();
    catRows.push([cid, storeId, name, color, icon]);
    acat[name] = cid;
    for (const item of items) aproducts.push({ name: item, category: name });
  }

  const aslots: Slot[] = [];
  for (const f of afaces) {
    const len = f.to - f.from;
    const n = Math.max(1, Math.floor(len / 2.0));
    for (let i = 0; i < n; i++) {
      const at = f.from + ((i + 0.5) * len) / n;
      aslots.push(f.axis === 'h' ? { x: at, y: f.line, hall: f.axis === 'h' } : { x: f.line, y: at, hall: f.line < 32 });
    }
  }
  const hallSlots = aslots.filter((s) => s.hall);
  const whSlots = aslots.filter((s) => !s.hall);
  const hallItems = aproducts.filter((p) => !['Hardware', 'Bulk'].includes(p.category));
  const whItems = aproducts.filter((p) => ['Hardware', 'Bulk'].includes(p.category));

  const prodRows: ProdRow[] = [];
  const locRows: LocRow[] = [];
  const place = (items: { name: string; category: string }[], slots: Slot[]) => {
    for (let i = 0; i < items.length && slots.length; i++) {
      const slot = slots[Math.floor((i * slots.length) / items.length)];
      const pid = newId();
      prodRows.push([
        pid, storeId, acat[items[i].category], items[i].name, 'Harbour Line',
        `ANN-${String(i + 1).padStart(3, '0')}`, '', '', Math.round((0.95 + ((i * 53) % 1800) / 100) * 100) / 100, '',
      ]);
      locRows.push([newId(), pid, floorId, slot.x, slot.y]);
    }
  };
  place(hallItems, hallSlots);
  place(whItems, whSlots);

  await insertAll(env, ELEMENT_SQL, elements);
  await insertAll(env, 'INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)', catRows);
  await insertAll(env, PRODUCT_SQL, prodRows);
  await insertAll(env, LOCATION_SQL, locRows);
}

/** Seed both demo stores. Safe to race: unique slugs fail the second run. */
export async function seedDemoMaps(env: Env): Promise<void> {
  const ownerId = await ensureDemoOwner(env);
  await seedFreshmart(env, ownerId);
  await seedAnnex(env, ownerId);
  console.log('[boot] demo maps seeded (Freshmart Downtown + Annex Market)');
}
