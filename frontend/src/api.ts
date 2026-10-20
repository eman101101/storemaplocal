import type {
  AuthInfo, Category, Floor, MapElementRow, Product, ProductLocation, PublicStorePayload,
  Store, StoreFull, StoreSummary, StockRow, StockMovement, ApiKeyRow,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFile = init?.body instanceof File;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body && !isFile ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error || `Request failed (${res.status})`);
  }
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  me: () => request<AuthInfo>('/api/auth/me'),
  devLogin: (email: string, name?: string) =>
    request<{ user: unknown }>('/api/auth/dev-login', {
      method: 'POST',
      body: json({ email, name }),
    }),
  /** Upload a product photo (raw bytes); paid plan or local mode required. */
  productImage: (productId: string, file: File) =>
    request<{ url: string; product: Product }>(`/api/products/${productId}/image`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  removeProductImage: (productId: string) =>
    request<{ ok: true }>(`/api/products/${productId}/image`, { method: 'DELETE' }),
  /** One-click session as the demo-map owner (server-gated, dev only). */
  demoLogin: () => request<{ user: unknown }>('/api/auth/demo-login', { method: 'POST' }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  // Stores
  duplicateStore: (id: string, name?: string) =>
    request<{ store: Store }>(`/api/stores/${id}/duplicate`, { method: 'POST', body: json({ name }) }),
  /** Download a self-contained transfer bundle (map + catalog + images). */
  exportStore: async (id: string, slug: string) => {
    const res = await fetch(`/api/stores/${id}/export`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-storemap.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  /** Restore a transfer bundle as a new draft store on this instance. */
  importStore: (file: File) =>
    request<{ store: Store }>('/api/stores/import', { method: 'POST', body: file }),
  myStores: () => request<{ stores: StoreSummary[] }>('/api/stores/mine'),
  createStore: (body: Partial<Store>) =>
    request<{ store: Store }>('/api/stores', { method: 'POST', body: json(body) }),
  storeFull: (id: string) => request<StoreFull>(`/api/stores/${id}/full`),
  updateStore: (id: string, body: Partial<Store>) =>
    request<{ store: Store }>(`/api/stores/${id}`, { method: 'PATCH', body: json(body) }),
  deleteStore: (id: string) =>
    request<{ ok: true }>(`/api/stores/${id}`, { method: 'DELETE' }),

  // Floors
  addFloor: (storeId: string, body: Partial<Floor>) =>
    request<{ floor: Floor }>(`/api/stores/${storeId}/floors`, { method: 'POST', body: json(body) }),
  updateFloor: (floorId: string, body: Partial<Floor>) =>
    request<{ floor: Floor }>(`/api/floors/${floorId}`, { method: 'PATCH', body: json(body) }),
  deleteFloor: (floorId: string) =>
    request<{ ok: true }>(`/api/floors/${floorId}`, { method: 'DELETE' }),

  // Map elements (bulk autosave)
  saveElements: (floorId: string, elements: MapElementRow[]) =>
    request<{ elements: MapElementRow[] }>(`/api/floors/${floorId}/elements`, {
      method: 'PUT',
      body: json({ elements }),
    }),

  // Categories
  addCategory: (storeId: string, body: Partial<Category>) =>
    request<{ category: Category }>(`/api/stores/${storeId}/categories`, {
      method: 'POST',
      body: json(body),
    }),
  updateCategory: (id: string, body: Partial<Category>) =>
    request<{ category: Category }>(`/api/categories/${id}`, { method: 'PATCH', body: json(body) }),
  deleteCategory: (id: string) =>
    request<{ ok: true }>(`/api/categories/${id}`, { method: 'DELETE' }),

  // Products
  addProduct: (storeId: string, body: Partial<Product>) =>
    request<{ product: Product }>(`/api/stores/${storeId}/products`, {
      method: 'POST',
      body: json(body),
    }),
  updateProduct: (id: string, body: Partial<Product>) =>
    request<{ product: Product }>(`/api/products/${id}`, { method: 'PATCH', body: json(body) }),
  deleteProduct: (id: string) =>
    request<{ ok: true }>(`/api/products/${id}`, { method: 'DELETE' }),

  // Locations
  setProductLocation: (productId: string, body: { floor_id: string; x: number; y: number }) =>
    request<{ location: ProductLocation }>(`/api/products/${productId}/locations`, {
      method: 'POST',
      body: json(body),
    }),
  deleteLocation: (id: string) =>
    request<{ ok: true }>(`/api/locations/${id}`, { method: 'DELETE' }),

  // Autosave snapshots (the editor's changelog)
  floorSnapshots: (floorId: string) =>
    request<{ snapshots: { id: string; element_count: number; created_at_ms: number }[] }>(
      `/api/floors/${floorId}/snapshots`
    ),
  floorSnapshot: (floorId: string, snapId: string) =>
    request<{ snapshot: { id: string; element_count: number; created_at_ms: number; elements: MapElementRow[] } }>(
      `/api/floors/${floorId}/snapshots/${snapId}`
    ),

  // Uploads (raw image bytes) — downscaled client-side first (E4) so the
  // store never stores a 10 MB phone photo: max 2048 px, WebP q0.85, with a
  // PNG passthrough when the canvas can't re-encode.
  uploadImage: async (file: File): Promise<{ url: string }> => {
    const compressed = await compressImage(file);
    file = compressed ?? file;
    const res = await fetch('/api/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'image/png' },
      body: file,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.error || 'Upload failed');
    return body;
  },

  // Public
  publicStores: (q = '') =>
    request<{ stores: StoreSummary[] }>(`/api/public/stores?q=${encodeURIComponent(q)}`),
  publicStore: (slug: string) => request<PublicStorePayload>(`/api/public/stores/${slug}`),

  // ---- Stock tracking & integrations ----
  stock: (storeId: string) =>
    request<{ stock: StockRow[]; movements: StockMovement[] }>(`/api/stores/${storeId}/stock`),
  adjustStock: (storeId: string, body: { product_id: string; delta: number; reason?: string }) =>
    request<{ level: { quantity: number } }>(`/api/stores/${storeId}/stock/adjust`, { method: 'POST', body: json(body) }),
  setStock: (storeId: string, body: { product_id: string; quantity: number; reason?: string }) =>
    request<{ level: { quantity: number } }>(`/api/stores/${storeId}/stock/set`, { method: 'POST', body: json(body) }),

  apiKeys: (storeId: string) =>
    request<{ keys: ApiKeyRow[] }>(`/api/stores/${storeId}/keys`),
  createApiKey: (storeId: string, name: string) =>
    request<{ key: ApiKeyRow; api_key: string }>(`/api/stores/${storeId}/keys`, {
      method: 'POST',
      body: json({ name }),
    }),
  revokeApiKey: (keyId: string) =>
    request<{ ok: true }>(`/api/stores/keys/${keyId}`, { method: 'DELETE' }),

  importCsv: (storeId: string, csv: string) =>
    request<{ imported: number; total: number }>(`/api/stores/${storeId}/integrations/csv`, {
      method: 'POST',
      body: json({ csv }),
    }),
};


/** E4: shrink an image to ≤2048 px WebP before upload; null = keep original. */
async function compressImage(file: File): Promise<File | null> {
  if (!file.type.startsWith('image/')) return null;
  if (file.type === 'image/gif') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const MAX = 2048;
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size <= 600 * 1024) return null; // already small enough
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.85)
    );
    if (!blob || blob.size >= file.size) return null;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
  } catch {
    return null;
  }
}
