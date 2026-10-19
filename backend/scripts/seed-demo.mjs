#!/usr/bin/env node
/**
 * Seeds the demo store ("Freshmart Downtown") with a realistic supermarket:
 * perimeter walls with stocked wall shelving around most of the border, a checkout
 * area by the entrance, and central double-sided gondola pairs facing each other
 * across aisles — like a real grocery store. 150 products pinned to the shelf
 * faces (the wall each item is stocked against).
 *
 *   node scripts/seed-demo.mjs            # idempotent — skips if already seeded
 *   node scripts/seed-demo.mjs --reset    # wipe the demo store and rebuild
 */
import { randomUUID } from 'node:crypto';
// The same database handle the server uses (honours DATA_DIR) and the schema
// migrations, so the script works standalone on a machine that never booted it.
import { db, migrate } from '../src/db.js';

migrate();

const reset = process.argv.includes('--reset');
const tiny = process.argv.includes('--tiny') || process.argv.includes('--profile=tiny');
const W = 54; // floor size, meters
const H = 36;

// The demo owner account — "Open the demo maps" signs into it (config.demoLoginEmail),
// so every seeded demo store must belong to it.
let owner = db.prepare("SELECT id FROM users WHERE email = 'annex@storemap.demo'").get();
if (!owner) {
  const uid = randomUUID();
  db.prepare("INSERT INTO users (id, email, name, provider, provider_sub) VALUES (?, ?, ?, 'dev', ?)").run(
    uid, 'annex@storemap.demo', 'Demo Map Owner', 'demo-owner'
  );
  owner = { id: uid };
}

let store = db.prepare("SELECT id FROM stores WHERE slug = 'freshmart-downtown'").get();
if (!store) {
  const sid = randomUUID();
  db.prepare(
    `INSERT INTO stores (id, owner_id, name, slug, address, description, hours, is_public)
     VALUES (?, ?, 'Freshmart Downtown', 'freshmart-downtown', '400 Main St',
             'The full-size supermarket demo: perimeter wall shelving, double-sided gondola aisles, checkout by the entrance.',
             '8am–10pm daily', 1)`
  ).run(sid, owner.id);
  db.prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(), sid, 'Main floor', 1, W, H
  );
  store = { id: sid };
  console.log('Created Freshmart Downtown (freshmart-downtown).');
}
let floor = db.prepare('SELECT id, width_m, height_m FROM floors WHERE store_id = ? ORDER BY level LIMIT 1').get(store.id);
if (!floor) {
  db.prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(), store.id, 'Main floor', 1, W, H
  );
  floor = db.prepare('SELECT id, width_m, height_m FROM floors WHERE store_id = ? ORDER BY level LIMIT 1').get(store.id);
}
const shelfCount = db.prepare("SELECT COUNT(*) AS n FROM map_elements WHERE floor_id = ? AND type = 'shelf'").get(floor.id).n;

if (reset) {
  db.prepare('DELETE FROM product_locations WHERE floor_id = ?').run(floor.id);
  db.prepare('DELETE FROM products WHERE store_id = ?').run(store.id);
  db.prepare('DELETE FROM categories WHERE store_id = ?').run(store.id);
  db.prepare('DELETE FROM map_elements WHERE floor_id = ?').run(floor.id);
  db.prepare('UPDATE floors SET width_m = ?, height_m = ? WHERE id = ?').run(W, H, floor.id);
  console.log(`Reset demo store — rebuilding at ${W}×${H} m.`);
} else if (shelfCount >= 6 && Math.abs(floor.width_m - W) < 0.01) {
  console.log('Demo layout already present — skipping (use --reset to rebuild).');
}
// labeled block: "already present" skips only the Freshmart rebuild — the
// Annex Market section further down still runs
freshmart: {
if (!reset && shelfCount >= 6 && Math.abs(floor.width_m - W) < 0.01) break freshmart;
floor = db.prepare('SELECT id FROM floors WHERE store_id = ? ORDER BY level LIMIT 1').get(store.id);

const insEl = db.prepare(
  "INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)"
);
let z = 1;
const rect = (type, x, y, w, h, label = '') =>
  insEl.run(randomUUID(), floor.id, type, 'rect', JSON.stringify({ x, y, w, h, rot: 0 }), label, '', z++);
const point = (type, x, y, label = '') =>
  insEl.run(randomUUID(), floor.id, type, 'point', JSON.stringify({ x, y }), label, '', z++);

/* ---------- structure: walls, entrance, checkout, POIs ---------- */

rect('wall', 0, 0, W, 0.4, 'North wall');
rect('wall', 0, H - 0.4, W, 0.4, 'South wall');
rect('wall', 0, 0, 0.4, H, 'West wall');
rect('wall', W - 0.4, 0, 0.4, H, 'East wall');

point('entrance', 27, H - 0.9, 'Entrance');
point('exit', 31, H - 0.9, 'Exit');

rect('zone', 20, 29.6, 14, 3.2); // checkout area — counters are labeled individually
for (let i = 0; i < 4; i++) rect('shelf', 21.3 + i * 3.4, 30.3, 2.3, 1.3, `Checkout ${i + 1}`);

point('poi', 48.5, 33.2, 'Customer service');
point('poi', 2.2, 28.5, 'Restrooms');

/* ---------- shelves: stocked border + central facing aisle pairs ---------- */

// wall shelving around most of the border (inner faces hold products).
// 0.15 m gap from the wall: keeps faces coplanar-free so the 3D depth sort
// never ties a shelf face against the wall face behind it.
rect('shelf', 0.55, 2, 1.1, 31.35, 'West wall');
rect('shelf', 2, 0.55, W - 4.15, 1.1, 'North wall');
rect('shelf', W - 1.65, 2, 1.1, 31.35, 'East wall');
rect('shelf', 2, H - 1.65, 17, 1.1, 'South wall');
rect('shelf', 35, H - 1.65, 17, 1.1, 'South wall');

// central gondola pairs: two rows facing each other across a 1.5 m aisle
const SEGMENTS = [
  [6, 19],
  [28, 19],
]; // [x, length]
const faces = []; // product stocking lines: {axis:'h'|'v', line, from, to}
for (let p = 0; p < 4; p++) {
  const y0 = 6 + p * 6;
  const label = `Aisle ${p + 1}`;
  for (const [x0, len] of SEGMENTS) {
    rect('shelf', x0, y0, len, 0.7, label); // row A — its north + south faces
    rect('shelf', x0, y0 + 2.2, len, 0.7, label); // row B — faces the aisle
    faces.push({ axis: 'h', line: y0, from: x0 + 0.4, to: x0 + len - 0.4 });
    faces.push({ axis: 'h', line: y0 + 0.7, from: x0 + 0.4, to: x0 + len - 0.4 });
    faces.push({ axis: 'h', line: y0 + 2.2, from: x0 + 0.4, to: x0 + len - 0.4 });
    faces.push({ axis: 'h', line: y0 + 2.9, from: x0 + 0.4, to: x0 + len - 0.4 });
  }
}
// border stocking lines (inner faces of the wall shelving)
faces.push({ axis: 'v', line: 1.65, from: 2.6, to: H - 2.9 });
faces.push({ axis: 'h', line: 1.65, from: 2.6, to: W - 2.6 });
faces.push({ axis: 'v', line: W - 1.65, from: 2.6, to: H - 2.9 });
faces.push({ axis: 'h', line: H - 1.65, from: 2.6, to: 18.8 });
faces.push({ axis: 'h', line: H - 1.65, from: 35.2, to: W - 2.6 });

/* ---------- categories & 150 products pinned to the shelf faces ---------- */

const insCat = db.prepare('INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)');
const insProd = db.prepare(
  'INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const insLoc = db.prepare(
  "INSERT INTO product_locations (id, product_id, floor_id, x, y, rot, meta) VALUES (?, ?, ?, ?, ?, 0, '{}')"
);

const CATS = [
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

const cat = {};
const products = [];
for (const [name, color, icon, , items] of CATS) {
  const existing = db.prepare('SELECT id FROM categories WHERE store_id = ? AND name = ?').get(store.id, name);
  const id = existing?.id ?? randomUUID();
  if (!existing) insCat.run(id, store.id, name, color, icon);
  cat[name] = id;
  for (const item of items) products.push({ name: item, category: name });
}

// even slots along every stocking face, then sample 150 of them across the store
const slots = [];
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
for (let i = 0; i < take; i++) {
  const slot = slots[Math.min(total - 1, Math.round((i * total) / take))];
  const p = products[i];
  const id = randomUUID();
  const price = Math.round((0.79 + ((i * 37) % 920) / 100) * 100) / 100;
  insProd.run(id, store.id, cat[p.category], p.name, BRANDS[i % BRANDS.length], `${p.category.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`, '', '', price, '');
  insLoc.run(randomUUID(), id, floor.id, slot.x, slot.y);
}

if (tiny) {
  // tiny profile: strip to one aisle pair + entrance for docs/GIFs
  db.prepare("DELETE FROM map_elements WHERE label NOT LIKE 'Aisle 1%' AND type = 'shelf'").run();
  db.prepare('DELETE FROM product_locations WHERE id NOT IN (SELECT id FROM product_locations LIMIT 12)').run();
  console.log('Tiny profile applied: single aisle, 12 pins.');
}
console.log(`Seeded Freshmart Downtown: ${W}×${H} m, checkout area, border + aisle-pair shelving, ${take} products with pins.`);
} // end freshmart block

/* ══════════════════════════════════════════════════════════════════════════
   Annex Market — a COMPLEX-SHAPE example: an L-shaped retail hall (notched
   north-east corner with a loading dock) plus an attached warehouse room
   along the south-east. Traced with polyline walls so the footprint really
   is the union shape, an interior wall with a doorway between hall and
   warehouse, aisle ribbons with labels in both the hall and the warehouse,
   and products pinned along every face. Idempotent per store.
   ══════════════════════════════════════════════════════════════════════════ */

const AW = 48; // annex floor size, meters
const AH = 46;
const resetAnnex = reset || process.argv.includes('--reset-annex');

let annex = db.prepare("SELECT id FROM stores WHERE slug = 'annex-market'").get();
if (!annex) {
  // its own demo owner so it never collides with a real account's stores
  let owner = db.prepare("SELECT id FROM users WHERE email = 'annex@storemap.demo'").get();
  if (!owner) {
    const uid = randomUUID();
    db.prepare("INSERT INTO users (id, email, name, provider, provider_sub) VALUES (?, ?, ?, 'dev', ?)").run(
      uid, 'annex@storemap.demo', 'Annex Demo', 'annex-demo'
    );
    owner = { id: uid };
  }
  const sid = randomUUID();
  db.prepare(
    `INSERT INTO stores (id, owner_id, name, slug, address, description, hours, is_public)
     VALUES (?, ?, 'Annex Market', 'annex-market', '12 Harbour Rd',
             'Complex-shape example: L-shaped hall with a loading-dock notch and an attached backstock warehouse.',
             '7am-11pm daily', 1)`
  ).run(sid, owner.id);
  db.prepare('INSERT INTO floors (id, store_id, name, level, width_m, height_m) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(), sid, 'Main + Warehouse', 1, AW, AH
  );
  annex = { id: sid };
  console.log('Created Annex Market (annex-market).');
}
let annexFloor = db.prepare('SELECT id FROM floors WHERE store_id = ? ORDER BY level LIMIT 1').get(annex.id);
const annexShelves = db
  .prepare("SELECT COUNT(*) AS n FROM map_elements WHERE floor_id = ? AND type = 'shelf'")
  .get(annexFloor.id).n;

if (resetAnnex && annexShelves > 0) {
  db.prepare('DELETE FROM product_locations WHERE floor_id = ?').run(annexFloor.id);
  db.prepare('DELETE FROM products WHERE store_id = ?').run(annex.id);
  db.prepare('DELETE FROM categories WHERE store_id = ?').run(annex.id);
  db.prepare('DELETE FROM map_elements WHERE floor_id = ?').run(annexFloor.id);
  annexShelves = 0;
  console.log('Reset Annex Market — rebuilding.');
}

if (annexShelves === 0) {
  db.prepare('UPDATE floors SET width_m = ?, height_m = ? WHERE id = ?').run(AW, AH, annexFloor.id);
  annexFloor = db.prepare('SELECT id FROM floors WHERE store_id = ? ORDER BY level LIMIT 1').get(annex.id);
  const insA = db.prepare(
    "INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)"
  );
  let az = 1;
  const arect = (type, x, y, w, h, label = '') =>
    insA.run(randomUUID(), annexFloor.id, type, 'rect', JSON.stringify({ x, y, w, h, rot: 0 }), label, '', az++);
  const apoly = (type, pts, label = '') =>
    insA.run(randomUUID(), annexFloor.id, type, 'polyline', JSON.stringify(pts.map((p) => [p[0], p[1]])), label, '', az++);
  const apoint = (type, x, y, label = '') =>
    insA.run(randomUUID(), annexFloor.id, type, 'point', JSON.stringify({ x, y }), label, '', az++);

  /* ---- complex footprint: L-hall ∪ east wing ∪ attached warehouse ----
     Union outline (clockwise): hall [0..32]×[0..34], east wing [32..48]×[8..34],
     warehouse [32..48]×[34..46]; the NE notch [32..48]×[0..8] is the dock. */
  apoly('wall', [
    [0, 0], [32, 0], [32, 8], [48, 8], [48, 46], [32, 46], [32, 34], [0, 34], [0, 0],
  ], 'Outer walls');
  // interior wall between the east wing and the warehouse, doorway at x 38..41
  apoly('wall', [[32, 34], [38, 34]], 'Hall / warehouse');
  apoly('wall', [[41, 34], [48, 34]], 'Hall / warehouse');

  apoint('entrance', 6, 32.8, 'Entrance');
  apoint('exit', 26, 32.8, 'Exit');
  arect('zone', 2.5, 27.5, 13, 5, 'Checkout');
  for (let i = 0; i < 3; i++) arect('shelf', 4 + i * 4, 28.6, 2.6, 1.2, `Checkout ${i + 1}`);
  apoint('poi', 44.5, 3.5, 'Loading dock');
  arect('zone', 33, 1, 14, 6); // the POI pole carries the label — zone + pole would double it

  /* ---- hall shelving: border + four aisle pairs ---- */
  arect('shelf', 0.55, 2.5, 1.1, 30, 'West wall');
  arect('shelf', 2, 0.55, 28, 1.1, 'North wall');
  const afaces = [];
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

  /* ---- east wing: two vertical aisle pairs (seasonal) ---- */
  arect('zone', 33.2, 9.2, 14.6, 23.8, 'Seasonal');
  for (let v = 0; v < 2; v++) {
    const x0 = 35.2 + v * 6.4;
    const label = `Aisle ${5 + v}`;
    arect('shelf', x0, 10, 0.7, 21, label);
    arect('shelf', x0 + 2.7, 10, 0.7, 21, label);
    apoly('aisle', [[x0 + 1.7, 11], [x0 + 1.7, 30]], label);
    for (const line of [x0, x0 + 0.7, x0 + 2.7, x0 + 3.4]) afaces.push({ axis: 'v', line, from: 11, to: 30 });
  }

  /* ---- warehouse: tall racks off a corridor from the doorway ---- */
  arect('zone', 32.6, 34.6, 14.8, 10.8, 'Backstock');
  apoly('aisle', [[35, 40], [45, 40]], 'Rack row');
  for (let r = 0; r < 3; r++) {
    const x = 34.2 + r * 4.4;
    arect('shelf', x, 36.2, 1.3, 7.6, `Rack ${r + 1}`);
    afaces.push({ axis: 'v', line: x + 0.05, from: 36.6, to: 43.4 });
    afaces.push({ axis: 'v', line: x + 1.25, from: 36.6, to: 43.4 });
  }
  apoint('poi', 39.5, 44.9, 'Receiving');

  /* ---- categories + products pinned along every face ---- */
  const insACat = db.prepare('INSERT INTO categories (id, store_id, name, color, icon) VALUES (?, ?, ?, ?, ?)');
  const insAProd = db.prepare(
    'INSERT INTO products (id, store_id, category_id, name, brand, sku, barcode, description, price, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insALoc = db.prepare(
    "INSERT INTO product_locations (id, product_id, floor_id, x, y, rot, meta) VALUES (?, ?, ?, ?, ?, 0, '{}')"
  );
  const ACATS = [
    ['Dairy', '#3b6fd4', '🥛', ['Whole Milk 1L', 'Butter 250g', 'Cheddar 350g', 'Greek Yogurt 500g', 'Oat Milk 1L', 'Brie 200g']],
    ['Produce', '#2f9e44', '🥬', ['Bananas', 'Apples 4-pack', 'Rocket 100g', 'Tomatoes 500g', 'Avocados 2-pack', 'Carrots 1kg']],
    ['Snacks', '#d4a017', '🍿', ['Sea Salt Crisps', 'Tortilla Chips', 'Milk Chocolate', 'Cookies 300g', 'Pretzels', 'Popcorn']],
    ['Household', '#3a7ca5', '🧻', ['Kitchen Roll', 'Laundry Pods', 'Bin Bags', 'Washing Up Liquid', 'Bleach', 'Sponges']],
    ['Seasonal', '#e4572e', '🎃', ['Pumpkin', 'Fairy Lights', 'Gift Wrap', 'Candles', 'Wreath', 'Advent Calendar']],
    ['Hardware', '#7950f2', '🔧', ['Duct Tape', 'Batteries AA', 'Light Bulbs', 'Extension Lead', 'Screwdriver Set', 'Work Gloves']],
    ['Bulk', '#c47f17', '📦', ['Rice 10kg', 'Flour 5kg', 'Olive Oil 5L', 'Detergent 10L', 'Dog Food 12kg', 'Cat Litter 10L']],
  ];
  const aproducts = [];
  const acat = {};
  for (const [name, color, icon, items] of ACATS) {
    const cid = randomUUID();
    insACat.run(cid, annex.id, name, color, icon);
    acat[name] = cid;
    for (const item of items) aproducts.push({ name: item, category: name });
  }
  // warehouse faces get the Hardware/Bulk tail of the list; hall faces the rest
  const hallFaceCount = afaces.filter((f) => f.from > 5).length; // hall faces run longer — cheap split proxy
  const aslots = [];
  for (const f of afaces) {
    const len = f.to - f.from;
    const n = Math.max(1, Math.floor(len / 2.0));
    for (let i = 0; i < n; i++) {
      const at = f.from + ((i + 0.5) * len) / n;
      aslots.push(f.axis === 'h' ? { x: at, y: f.line, hall: f.axis === 'h' } : { x: f.line, y: at, hall: f.line < 32 });
    }
  }
  void hallFaceCount;
  const hallSlots = aslots.filter((s) => s.hall);
  const whSlots = aslots.filter((s) => !s.hall);
  const hallItems = aproducts.filter((p) => !['Hardware', 'Bulk'].includes(p.category));
  const whItems = aproducts.filter((p) => ['Hardware', 'Bulk'].includes(p.category));
  const place = (items, slots) => {
    for (let i = 0; i < items.length && slots.length; i++) {
      const slot = slots[Math.floor((i * slots.length) / items.length)];
      const pid = randomUUID();
      insAProd.run(
        pid, annex.id, acat[items[i].category], items[i].name, 'Harbour Line',
        `ANN-${String(i + 1).padStart(3, '0')}`, '', '', Math.round((0.95 + ((i * 53) % 1800) / 100) * 100) / 100, ''
      );
      insALoc.run(randomUUID(), pid, annexFloor.id, slot.x, slot.y);
    }
  };
  place(hallItems, hallSlots);
  place(whItems, whSlots);
  console.log(`Seeded Annex Market: ${AW}×${AH} m complex footprint (L-hall + dock notch + warehouse), aisles labeled, ${hallItems.length + whItems.length} products.`);
} else {
  console.log('Annex Market layout already present — skipping (use --reset-annex to rebuild).');
}
