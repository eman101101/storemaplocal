import { describe, it, expect } from 'vitest';
import { signHs256, verifyHs256, decodeJwt } from '../src/crypto';
import { toB64Url, fromB64Url, timingSafeEqual, randomToken } from '../src/util';
import { validateElement } from '../src/validate';
import { parseCsv, toCsv, rowsFromCsv } from '../src/csv';
import { slugify } from '../src/http';

describe('base64url', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...fromB64Url(toB64Url(bytes))]).toEqual([...bytes]);
  });

  it('handles url-safe characters', () => {
    const s = '~~>?';
    const encoded = toB64Url(new TextEncoder().encode(s));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('HS256 sessions', () => {
  it('signs and verifies', async () => {
    const token = await signHs256({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
    const payload = await verifyHs256(token, 'secret');
    expect(payload.sub).toBe('u1');
  });

  it('rejects a wrong secret', async () => {
    const token = await signHs256({ sub: 'u1' }, 'secret');
    await expect(verifyHs256(token, 'other')).rejects.toThrow('bad signature');
  });

  it('rejects tampered signatures', async () => {
    const token = await signHs256({ sub: 'u1' }, 'secret');
    const parts = token.split('.');
    const sig = fromB64Url(parts[2]);
    sig[0] ^= 1;
    const tampered = `${parts[0]}.${parts[1]}.${toB64Url(sig)}`;
    await expect(verifyHs256(tampered, 'secret')).rejects.toThrow('bad signature');
  });

  it('decodes header and payload', async () => {
    const token = await signHs256({ sub: 'u2' }, 's');
    const { header, payload } = decodeJwt(token);
    expect(header.alg).toBe('HS256');
    expect(payload.sub).toBe('u2');
  });
});

describe('timingSafeEqual', () => {
  it('matches equal bytes and rejects different ones', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('randomToken', () => {
  it('is url-safe and sized', () => {
    const t = randomToken(24);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(20);
  });
});

describe('validateElement', () => {
  it('accepts a rect shelf and normalises rotation', () => {
    const row = validateElement({ type: 'shelf', shape: 'rect', geometry: { x: 1, y: 2, w: 3, h: 4, rot: 370 } });
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.geometry)).toEqual({ x: 1, y: 2, w: 3, h: 4, rot: 10 });
  });

  it('rejects bad types and shapes', () => {
    expect(validateElement({ type: 'nope', shape: 'rect', geometry: { x: 1, y: 2, w: 3, h: 4 } })).toBeNull();
    expect(validateElement({ type: 'entrance', shape: 'rect', geometry: { x: 1, y: 2, w: 3, h: 4 } })).toBeNull();
    expect(validateElement({ type: 'shelf', shape: 'rect', geometry: { x: 1, y: 2, w: 0, h: 4 } })).toBeNull();
  });

  it('accepts polylines and points', () => {
    expect(validateElement({ type: 'aisle', shape: 'polyline', geometry: [[0, 0], [5, 0]] })).not.toBeNull();
    expect(validateElement({ type: 'poi', shape: 'point', geometry: { x: 1.5, y: 2.5 } })).not.toBeNull();
    expect(validateElement({ type: 'aisle', shape: 'polyline', geometry: [[0, 0]] })).toBeNull();
  });
});

describe('csv', () => {
  it('parses quoted fields', () => {
    const rows = parseCsv('name,price\n"Milk, 1L",2.50\nBread,1.00');
    expect(rows).toEqual([
      { name: 'Milk, 1L', price: '2.50' },
      { name: 'Bread', price: '1.00' },
    ]);
  });

  it('round-trips toCsv', () => {
    const csv = toCsv([{ a: '1', b: 'x,y' }, { a: '2', b: 'z' }]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,z');
  });

  it('maps tolerant headers', () => {
    const rows = rowsFromCsv('Item Code,Product Name,Stock\nABC,Beans,10');
    expect(rows[0]).toMatchObject({ sku: 'ABC', name: 'Beans', quantity: 10 });
  });
});

describe('slugify', () => {
  // Pinned to the Node backend's exact output (combining marks become dashes)
  // so slugs stay identical across the Express and Workers deployments.
  it('slugs names and falls back', () => {
    expect(slugify('Café Bäckerei & More')).toBe('cafe-ba-ckerei-more');
    expect(slugify('')).toBe('store');
  });
});

describe('R2 circuit breaker', () => {
  it('trips only past the budget', async () => {
    const { budgetExceeded } = await import('../src/storage');
    expect(budgetExceeded(24_999, 25_000)).toBe(false);
    expect(budgetExceeded(25_000, 25_000)).toBe(false);
    expect(budgetExceeded(25_001, 25_000)).toBe(true);
  });

  it('placeholder is an SVG response', async () => {
    const { mediaPlaceholder } = await import('../src/storage');
    const res = mediaPlaceholder();
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await res.text()).toContain('daily media budget reached');
  });
});
