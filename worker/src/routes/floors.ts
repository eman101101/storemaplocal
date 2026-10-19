/** Floor routes incl. the elements autosave + snapshots (port of floors.js). */
import { Hono } from 'hono';
import type { AppEnv, Env } from '../config';
import { all, first, run, stmt } from '../db';
import { newId } from '../util';
import { json, badRequest, notFound } from '../http';
import { str, num, validateElement } from '../validate';
import { ownedFloor, touchStore } from '../ownership';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  if (!c.get('user')) return json(c, 401, { error: 'Authentication required' });
  await next();
});

/** PATCH /api/floors/:floorId — rename, resize, set background image. */
app.patch('/:floorId', async (c) => {
  const env = c.env as Env;
  const floor = await ownedFloor(c, env, c.req.param('floorId'));
  if (floor instanceof Response) return floor;
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = str(body.name, { max: 80, allowEmpty: false });
    if (!name) return badRequest(c, 'Floor name is required');
    updates.name = name;
  }
  for (const field of ['width_m', 'height_m']) {
    if (body?.[field] !== undefined) {
      const v = num(body[field]);
      if (!v || v < 1 || v > 500) return badRequest(c, `${field} must be between 1 and 500 meters`);
      updates[field] = v;
    }
  }
  if (body?.level !== undefined) {
    const level = num(body.level);
    if (level === undefined) return badRequest(c, 'Invalid level');
    updates.level = level;
  }
  if (body?.background_url !== undefined) updates.background_url = str(body.background_url, { max: 400 });
  const keys = Object.keys(updates);
  if (keys.length) {
    await run(env, `UPDATE floors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => updates[k]), floor.id);
    await touchStore(env, floor.store_id as string);
  }
  return json(c, 200, { floor: await first(env, 'SELECT * FROM floors WHERE id = ?', floor.id) });
});

app.delete('/:floorId', async (c) => {
  const env = c.env as Env;
  const floor = await ownedFloor(c, env, c.req.param('floorId'));
  if (floor instanceof Response) return floor;
  const cnt = await first(env, 'SELECT COUNT(*) c FROM floors WHERE store_id = ?', floor.store_id);
  if (Number(cnt?.c ?? 0) <= 1) return badRequest(c, 'A store must keep at least one floor');
  await run(env, 'DELETE FROM floors WHERE id = ?', floor.id);
  await touchStore(env, floor.store_id as string);
  return json(c, 200, { ok: true });
});

/**
 * PUT /api/floors/:floorId/elements — bulk replace the floor's elements.
 * The editor's autosave endpoint: one atomic batch, all-or-nothing.
 */
app.put('/:floorId/elements', async (c) => {
  const env = c.env as Env;
  const floor = await ownedFloor(c, env, c.req.param('floorId'));
  if (floor instanceof Response) return floor;
  const body = await c.req.json().catch(() => ({}));
  const list = Array.isArray(body?.elements) ? body.elements : null;
  if (!list) return badRequest(c, 'elements must be an array');
  if (list.length > 2000) return badRequest(c, 'Too many elements on one floor');

  const rows: { id: string; r: unknown[]; row: ReturnType<typeof validateElement> & object }[] = [];
  const seenIds = new Set<string>();
  for (const input of list) {
    const row = validateElement(input);
    if (!row) return badRequest(c, 'Invalid element in payload');
    const id = row.id && !seenIds.has(row.id) ? row.id : newId();
    seenIds.add(id);
    rows.push({ id, row, r: [id, floor.id, row.type, row.shape, row.geometry, row.label, row.color, row.meta, row.z_index] });
  }

  const statements = [
    stmt(env, 'DELETE FROM map_elements WHERE floor_id = ?', floor.id),
    ...rows.map(({ r }) => stmt(env, ELEMENT_INSERT, ...r)),
  ];
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  await touchStore(env, floor.store_id as string);
  await maybeSnapshot(env, floor.id, rows);
  const elements = await all(env, 'SELECT * FROM map_elements WHERE floor_id = ? ORDER BY z_index ASC, rowid ASC', floor.id);
  return json(c, 200, { elements });
});

const ELEMENT_INSERT = `INSERT INTO map_elements (id, floor_id, type, shape, geometry, label, color, meta, z_index)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/* ---------------- autosave snapshots (the editor's changelog) ---------------- */

const SNAP_MIN_INTERVAL_MS = 60_000;
const SNAP_MAX_PER_FLOOR = 20;

async function maybeSnapshot(env: Env, floorId: string, rows: { id: string; row: any }[]): Promise<void> {
  const last = await first(
    env,
    'SELECT created_at_ms FROM floor_snapshots WHERE floor_id = ? ORDER BY created_at_ms DESC LIMIT 1',
    floorId
  );
  if (last && Date.now() - Number(last.created_at_ms) < SNAP_MIN_INTERVAL_MS) return;
  const elements = rows.map(({ id, row }) => ({
    id,
    type: row.type,
    shape: row.shape,
    geometry: row.geometry,
    label: row.label,
    color: row.color,
    meta: row.meta,
    z_index: row.z_index,
  }));
  await run(
    env,
    'INSERT INTO floor_snapshots (id, floor_id, elements, element_count, created_at_ms) VALUES (?, ?, ?, ?, ?)',
    newId(), floorId, JSON.stringify(elements), elements.length, Date.now()
  );
  const ids = await all(
    env,
    'SELECT id FROM floor_snapshots WHERE floor_id = ? ORDER BY created_at_ms DESC LIMIT -1 OFFSET ?',
    floorId,
    SNAP_MAX_PER_FLOOR
  );
  for (const { id } of ids) await run(env, 'DELETE FROM floor_snapshots WHERE id = ?', id);
}

app.get('/:floorId/snapshots', async (c) => {
  const env = c.env as Env;
  const floor = await ownedFloor(c, env, c.req.param('floorId'));
  if (floor instanceof Response) return floor;
  const snapshots = await all(
    env,
    'SELECT id, element_count, created_at_ms FROM floor_snapshots WHERE floor_id = ? ORDER BY created_at_ms DESC',
    floor.id
  );
  return json(c, 200, { snapshots });
});

app.get('/:floorId/snapshots/:snapId', async (c) => {
  const env = c.env as Env;
  const floor = await ownedFloor(c, env, c.req.param('floorId'));
  if (floor instanceof Response) return floor;
  const row = await first(env, 'SELECT * FROM floor_snapshots WHERE id = ? AND floor_id = ?', c.req.param('snapId'), floor.id);
  if (!row) return notFound(c, 'Snapshot not found');
  return json(c, 200, {
    snapshot: {
      id: row.id,
      element_count: row.element_count,
      created_at_ms: row.created_at_ms,
      elements: JSON.parse(row.elements as string),
    },
  });
});

export default app;
