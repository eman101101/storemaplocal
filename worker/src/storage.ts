/**
 * Media storage on the R2 binding (port of backend/src/lib/storage.js).
 * Workers deployments are R2-only — the legacy local-disk branch doesn't apply.
 *
 * Circuit breaker: every R2 op passes r2BudgetOk(), a daily counter in D1
 * (R2 free tier is monthly, overages bill — this turns it into a hard daily
 * stop). While tripped, images serve a labeled placeholder and uploads are
 * refused; the rest of the site keeps working.
 */
import type { Env } from './config';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function defaultR2Budget(): number {
  return 25_000; // ≈ 5× a heavy store day (see the estimate table on /self-host)
}

export function budgetExceeded(used: number, budget: number): boolean {
  return used > budget;
}

let trippedDay: string | null = null; // per-isolate: stop re-checking once tripped

/**
 * Count one R2 op against today's budget and say whether it may proceed.
 * One atomic D1 write per op while under budget; once tripped, the day is
 * remembered in-isolate so a flood stops burning D1 writes.
 */
export async function r2BudgetOk(env: Env): Promise<boolean> {
  const budget = Number(env.R2_DAILY_BUDGET || defaultR2Budget());
  if (!Number.isFinite(budget) || budget <= 0) return true; // 0/negative = breaker off
  const day = new Date().toISOString().slice(0, 10);
  if (trippedDay === day) return false;

  const row = await env.DB.prepare(
    `INSERT INTO r2_budget (day, used) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET used = used + 1
     RETURNING used`
  )
    .bind(day)
    .first<{ used: number }>();
  const used = Number(row?.used ?? 0);

  // new day started? best-effort prune of old counter rows
  if (used === 1) {
    env.DB.prepare('DELETE FROM r2_budget WHERE day < ?')
      .bind(day)
      .run()
      .catch(() => {});
  }

  if (budgetExceeded(used, budget)) {
    trippedDay = day;
    return false;
  }
  return true;
}

/** Placeholder shown in place of images while the breaker is tripped. */
export function mediaPlaceholder(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <rect width="100%" height="100%" fill="#eef0ec"/>
  <rect x="1" y="1" width="298" height="198" fill="none" stroke="#c9cfc4"/>
  <text x="150" y="92" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="#5b6b5f">Image paused</text>
  <text x="150" y="114" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#8a988c">daily media budget reached — back tomorrow</text>
</svg>`;
  return new Response(svg, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' },
  });
}

/** Persist an image buffer. Returns the public URL path (`/uploads/<name>`). */
export async function saveImage(env: Env, buf: Uint8Array, ext: string): Promise<{ name: string; url: string }> {
  if (!(await r2BudgetOk(env))) throw new Error('R2_DAILY_BUDGET_REACHED');
  const name = `${crypto.randomUUID()}${ext}`;
  await env.MEDIA.put(`uploads/${name}`, buf as unknown as ArrayBuffer);
  return { name, url: `/uploads/${name}` };
}

/** Serve an uploaded image, or null (caller sends 404). Immutable long cache. */
export async function serveImage(env: Env, name: string): Promise<Response | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null; // no path tricks
  if (!(await r2BudgetOk(env))) return mediaPlaceholder();
  const obj = await env.MEDIA.get(`uploads/${name}`);
  if (!obj) return null;
  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()];
  if (type) headers.set('Content-Type', type);
  else if (obj.httpMetadata?.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
  return new Response(obj.body, { headers });
}
