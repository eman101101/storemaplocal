/** Input validation for API payloads (port of backend/src/lib/validate.js). */

export function str(v: unknown, { max = 500, allowEmpty = true } = {}): string | null | undefined {
  if (v === undefined || v === null) return allowEmpty ? '' : null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!allowEmpty && !s) return undefined;
  return s.slice(0, max);
}

export function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const ELEMENT_TYPES = new Set(['wall', 'shelf', 'aisle', 'zone', 'entrance', 'exit', 'poi']);
const TYPE_TO_SHAPE: Record<string, string[]> = {
  wall: ['rect', 'polyline', 'polygon'],
  shelf: ['rect', 'polygon'],
  aisle: ['polyline', 'rect'],
  zone: ['rect', 'polygon'],
  entrance: ['point'],
  exit: ['point'],
  poi: ['point'],
};
const HEX = /^#[0-9a-fA-F]{6}$/;

export interface ElementRow {
  id: string | undefined;
  type: string;
  shape: string;
  geometry: string;
  label: string;
  color: string;
  meta: string;
  z_index: number;
}

/** Validate one map element payload; returns a normalised row or null. */
export function validateElement(input: any): ElementRow | null {
  if (!input || typeof input !== 'object') return null;
  const { type, shape, geometry } = input;
  if (!ELEMENT_TYPES.has(type)) return null;
  if (!TYPE_TO_SHAPE[type].includes(shape)) return null;
  let geo: any = geometry;
  if (typeof geo === 'string') {
    try {
      geo = JSON.parse(geo);
    } catch {
      return null;
    }
  }
  if (shape === 'rect') {
    const { x, y, w, h, rot } = geo ?? {};
    if (![x, y, w, h].every((n: unknown) => Number.isFinite(n)) || w <= 0 || h <= 0) return null;
    geo = { x, y, w, h, rot: Number.isFinite(rot) ? ((rot % 360) + 360) % 360 : 0 };
  } else if (shape === 'point') {
    const { x, y } = geo ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    geo = { x, y };
  } else {
    if (!Array.isArray(geo) || geo.length < 2) return null;
    if (geo.length > 200) return null;
    if (!geo.every((p: unknown) => Array.isArray(p) && (p as unknown[]).length === 2 && (p as unknown[]).every(Number.isFinite)))
      return null;
    geo = geo.map((p: number[]) => [+p[0].toFixed(3), +p[1].toFixed(3)]);
  }
  const color = typeof input.color === 'string' && HEX.test(input.color) ? input.color : '';
  return {
    id: typeof input.id === 'string' && input.id.length <= 64 ? input.id : undefined,
    type,
    shape,
    geometry: JSON.stringify(geo),
    label: (str(input.label, { max: 80 }) as string) ?? '',
    color,
    meta: input.meta && typeof input.meta === 'object' ? JSON.stringify(input.meta).slice(0, 2000) : '{}',
    z_index: Number.isFinite(input.z_index) ? Math.trunc(input.z_index) : 0,
  };
}
