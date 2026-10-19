/** Thin async helpers so D1 reads like the node:sqlite idioms in the routes. */
import type { Env } from './config';

export interface D1Row {
  [key: string]: unknown;
}

export async function first(env: Env, sql: string, ...params: unknown[]): Promise<D1Row | null> {
  return await env.DB.prepare(sql).bind(...params).first<D1Row>();
}

export async function all(env: Env, sql: string, ...params: unknown[]): Promise<D1Row[]> {
  const res = await env.DB.prepare(sql).bind(...params).all<D1Row>();
  return res.results ?? [];
}

export async function run(env: Env, sql: string, ...params: unknown[]): Promise<void> {
  await env.DB.prepare(sql).bind(...params).run();
}

export async function count(env: Env, sql: string, ...params: unknown[]): Promise<number> {
  const row = await first(env, sql, ...params);
  for (const v of Object.values(row ?? {})) if (typeof v === 'number') return v;
  return 0;
}

/** D1 batch = one implicit transaction (all-or-nothing). */
export function tx(env: Env, stmts: D1PreparedStatement[]): D1PreparedStatement[] {
  return stmts;
}

export function stmt(env: Env, sql: string, ...params: unknown[]): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...params);
}
