/** Owner stock tracking + API keys (port of routes/stock.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run } from '../db';
import { newId } from '../util';
import { json, badRequest, notFound } from '../http';
import { ownedStore } from '../ownership';
import { adjustStock, setStock, stockForStore, movementsForStore, generateApiKey, hashKey } from '../stock';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
});

app.get('/:storeId/stock', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  return json(c, 200, {
    stock: await stockForStore(env, store.id),
    movements: await movementsForStore(env, store.id, 50),
  });
});

app.post('/:storeId/stock/adjust', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const delta = Number(body?.delta);
  if (!Number.isFinite(delta)) return badRequest(c, 'delta must be a number');
  const level = await adjustStock(env, store.id, body?.product_id, delta, { reason: body?.reason, source: 'manual' });
  if (!level) return badRequest(c, 'Product not found');
  return json(c, 200, { level });
});

app.post('/:storeId/stock/set', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const quantity = Number(body?.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) return badRequest(c, 'quantity must be a non-negative number');
  const level = await setStock(env, store.id, body?.product_id, quantity, { reason: body?.reason || 'count', source: 'manual' });
  if (!level) return badRequest(c, 'Product not found');
  return json(c, 200, { level });
});

/* ---------------- API keys ---------------- */

app.get('/:storeId/keys', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const keys = await all(
    env,
    'SELECT id, name, key_prefix, created_at, last_used_at, revoked FROM store_api_keys WHERE store_id = ? ORDER BY created_at DESC',
    store.id
  );
  return json(c, 200, { keys });
});

app.post('/:storeId/keys', async (c) => {
  const env = c.env as Env;
  const store = await ownedStore(c, env, c.req.param('storeId'));
  if (store instanceof Response) return store;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name || 'API key').slice(0, 80);
  const cnt = await first(env, 'SELECT COUNT(*) c FROM store_api_keys WHERE store_id = ? AND revoked = 0', store.id);
  if (Number(cnt?.c ?? 0) >= 20) return badRequest(c, 'Too many API keys');
  const { key, prefix } = await generateApiKey();
  const id = newId();
  await run(env, 'INSERT INTO store_api_keys (id, store_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?)', id, store.id, name, await hashKey(key), prefix);
  // The full key is shown exactly once — only its hash is stored.
  return json(c, 201, { key: { id, name, key_prefix: prefix, created_at: new Date().toISOString() }, api_key: key });
});

app.delete('/keys/:keyId', async (c) => {
  const env = c.env as Env;
  const row = await first(
    env,
    'SELECT k.id, s.owner_id FROM store_api_keys k JOIN stores s ON s.id = k.store_id WHERE k.id = ?',
    String(c.req.param('keyId'))
  );
  if (!row || row.owner_id !== c.get('user').id) return notFound(c, 'Key not found');
  await run(env, 'UPDATE store_api_keys SET revoked = 1 WHERE id = ?', row.id);
  return json(c, 200, { ok: true });
});

export default app;
