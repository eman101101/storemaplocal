/** Shared types mirroring the backend API rows. */

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string;
  provider: string;
}

export interface AuthInfo {
  user: User | null;
  providers: { google: boolean; apple: boolean; dev: boolean };
  selfHosted?: boolean;
}

export interface Store {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  address: string;
  description: string;
  phone: string;
  website: string;
  hours: string;
  logo_url: string;
  is_public: boolean;
  /** 'free' | 'pro' — pro unlocks paid-tier features on hosted instances. */
  plan: string;
  /** Canonical public link (server-built from PUBLIC_BASE_URL) — QR codes encode this. */
  shareUrl?: string;
  entitlements?: { productImages: boolean };
  created_at: string;
  updated_at: string;
}

export interface StoreSummary extends Store {
  floor_count?: number;
  product_count?: number;
  views?: number;
}

export interface Floor {
  id: string;
  store_id: string;
  name: string;
  level: number;
  width_m: number;
  height_m: number;
  background_url: string;
}

export type ElementType = 'wall' | 'shelf' | 'aisle' | 'zone' | 'entrance' | 'exit' | 'poi';
export type ElementShape = 'rect' | 'polygon' | 'polyline' | 'point';

export interface RectGeom { x: number; y: number; w: number; h: number; rot: number }
export interface PointGeom { x: number; y: number }
export type PolyGeom = [number, number][];

export interface MapElementRow {
  id: string;
  floor_id: string;
  type: ElementType;
  shape: ElementShape;
  geometry: string; // JSON
  label: string;
  color: string;
  meta: string;
  z_index: number;
}

/** Element with geometry parsed into a typed shape. */
export interface MapElement extends Omit<MapElementRow, 'geometry'> {
  geom: RectGeom | PointGeom | PolyGeom;
}

export function rectGeom(el: MapElement): RectGeom | null {
  return isRect(el.geom) ? el.geom : null;
}
export function isRect(g: unknown): g is RectGeom {
  return typeof g === 'object' && g !== null && 'w' in g && 'h' in g && 'rot' in g;
}
export function isPoint(g: unknown): g is PointGeom {
  return typeof g === 'object' && g !== null && 'x' in g && 'y' in g && !('w' in g) && !Array.isArray(g);
}
export function isPoly(g: unknown): g is PolyGeom {
  return Array.isArray(g);
}

export function parseElement(row: MapElementRow): MapElement {
  let geom: unknown;
  try {
    geom = JSON.parse(row.geometry);
  } catch {
    geom = { x: 0, y: 0 };
  }
  return { ...row, geom: geom as RectGeom | PointGeom | PolyGeom };
}

export function elementToRow(el: MapElement): MapElementRow {
  return { ...el, geometry: JSON.stringify(el.geom) };
}

export interface Category {
  id: string;
  store_id: string;
  name: string;
  color: string;
  icon: string;
}

export interface Product {
  id: string;
  store_id: string;
  category_id: string | null;
  name: string;
  brand: string;
  sku: string;
  barcode: string;
  description: string;
  price: number | null;
  image_url: string;
  category_name?: string;
  category_color?: string;
}

export interface ProductLocation {
  id: string;
  product_id: string;
  floor_id: string;
  x: number;
  y: number;
  rot: number;
  meta: string;
}

export interface StoreFull {
  store: Store;
  floors: Floor[];
  elements: MapElementRow[];
  categories: Category[];
  products: Product[];
  locations: ProductLocation[];
}

export interface PublicStorePayload {
  store: Omit<Store, 'owner_id' | 'is_public'>;
  floors: Floor[];
  elements: MapElementRow[];
  categories: Category[];
  products: Product[];
  locations: ProductLocation[];
}

export interface SearchResult {
  id: string;
  name: string;
  brand: string;
  sku: string;
  price: number | null;
  image_url: string;
  category_name: string;
  category_color: string;
  floor_id: string | null;
  x: number | null;
  y: number | null;
  floor_name: string | null;
}

/* ---------------- stock tracking ---------------- */

export interface StockRow {
  product_id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category_name: string | null;
  quantity: number | null;
  reorder_point: number | null;
  updated_at: string | null;
}

export interface StockMovement {
  id: string;
  product_id: string;
  product_name: string;
  delta: number;
  resulting_quantity: number;
  reason: string;
  source: string;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked?: number;
}

export interface ProviderField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required?: boolean;
  options?: string[];
  default?: string;
}

