/** Ownership checks + store touch (port of backend/src/lib/ownership.js). */
import type { Context } from 'hono';
import type { Env } from './config';
import { first, run } from './db';
import { notFound } from './http';

interface StoreRow {
  id: string;
  owner_id: string;
  [key: string]: unknown;
}

/** Returns the store row if owned by the user; otherwise sends the error and returns null. */
export async function ownedStore(c: Context, env: Env, storeId: unknown): Promise<StoreRow | null> {
  const store = await first(env, 'SELECT * FROM stores WHERE id = ? AND owner_id = ?', String(storeId), c.get('user').id);
  if (!store) {
    notFound(c, 'Store not found');
    return null;
  }
  return store as StoreRow;
}

/** Loads a floor and verifies its store is owned by the user. */
export async function ownedFloor(c: Context, env: Env, floorId: unknown): Promise<StoreRow | null> {
  const floor = await first(
    env,
    'SELECT f.*, s.owner_id FROM floors f JOIN stores s ON s.id = f.store_id WHERE f.id = ?',
    String(floorId)
  );
  if (!floor || floor.owner_id !== c.get('user').id) {
    notFound(c, 'Floor not found');
    return null;
  }
  return floor as StoreRow;
}

export async function touchStore(env: Env, storeId: string): Promise<void> {
  await run(env, `UPDATE stores SET updated_at = datetime('now') WHERE id = ?`, storeId);
}
