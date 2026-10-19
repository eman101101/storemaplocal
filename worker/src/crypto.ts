/**
 * JWT + OIDC primitives on WebCrypto (ports of backend/src/lib/jwt.js):
 * HS256 for session cookies, ES256 for Apple's client_secret, and ES256
 * id_token verification against Google/Apple JWKS.
 */
import { fromB64Url, toB64Url, fromUtf8, timingSafeEqual, utf8 } from './util';

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, any>;
  signingInput: string;
  signature: Uint8Array;
}

export function decodeJwt(token: string): JwtParts {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  return {
    header: JSON.parse(fromUtf8(fromB64Url(parts[0]))),
    payload: JSON.parse(fromUtf8(fromB64Url(parts[1]))),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: fromB64Url(parts[2]),
  };
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA256 signed JWT (sessions). */
export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = toB64Url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = toB64Url(utf8(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(input));
  return `${input}.${toB64Url(new Uint8Array(sig))}`;
}

export async function verifyHs256(token: string, secret: string): Promise<Record<string, any>> {
  const { payload, signingInput, signature } = decodeJwt(token);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(signingInput)));
  if (!timingSafeEqual(signature, expected)) throw new Error('bad signature');
  return payload;
}

function pemToDer(pem: string): Uint8Array {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return fromB64Url(body.replace(/-/g, '+').replace(/_/g, '/'));
}

/** ES256-signed JWT (Apple client_secret). keyPem: PKCS#8 or SEC1 EC private key. */
export async function signEs256(payload: Record<string, unknown>, keyPem: string, kid: string): Promise<string> {
  const header = toB64Url(utf8(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })));
  const body = toB64Url(utf8(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  let der = pemToDer(keyPem);
  // SEC1 EC keys ("BEGIN EC PRIVATE KEY") need wrapping into PKCS#8 for import;
  // Node-issued Apple keys are usually PKCS#8 already ("BEGIN PRIVATE KEY").
  if (/BEGIN EC PRIVATE KEY/.test(keyPem)) der = sec1ToPkcs8(der);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));
  return `${input}.${toB64Url(new Uint8Array(sig))}`;
}

/** Minimal SEC1 RFC5915 → PKCS#8 wrapper for P-256 keys. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  // PKCS#8 header for a P-256 EC key: 0x30 len 30 02 01 01 04 len [32-byte key]
  // preceded by the AlgorithmIdentifier. Build it around the SEC1 payload.
  const inner = new Uint8Array(sec1.length + 7);
  inner.set([0x30, sec1.length + 9, 0x02, 0x01, 0x01, 0x04, sec1.length], 0);
  inner.set(sec1, 7);
  const algId = new Uint8Array([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const out = new Uint8Array(inner.length + algId.length + 4);
  out[0] = 0x30;
  out[1] = 0x82; // lengths here exceed 127 bytes → long form
  out[2] = (inner.length + algId.length + 4) >> 8;
  out[3] = (inner.length + algId.length + 4) & 0xff;
  out[4] = 0x02;
  out[5] = 0x01;
  out[6] = 0x00; // version 0
  out.set(algId, 7);
  out.set(inner, 7 + algId.length);
  return out;
}

interface JwkCacheEntry {
  keys: Record<string, any>[];
  fetchedAt: number;
}
const jwkCache = new Map<string, JwkCacheEntry>(); // per-isolate; JWKS rotate hourly

export async function fetchJwks(jwksUrl: string): Promise<Record<string, any>[]> {
  const cached = jwkCache.get(jwksUrl);
  if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.keys;
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Record<string, any>[] };
  const keys = body.keys ?? [];
  jwkCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Verify an ES256 JWT against a concrete set of JWKs:
 * signature, issuer, audience, expiry and (optionally) nonce.
 */
export async function verifyEs256WithKeys(
  token: string,
  keys: Record<string, any>[],
  { issuer, audience, nonce }: { issuer?: string | string[]; audience?: string; nonce?: string } = {}
): Promise<Record<string, any>> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== 'ES256') throw new Error(`unexpected alg ${header.alg}`);
  const jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
  if (!jwk) throw new Error('no matching JWKS key');
  const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, utf8(signingInput));
  if (!ok) throw new Error('bad id_token signature');
  if (issuer !== undefined) {
    const issuers = Array.isArray(issuer) ? issuer : [issuer];
    if (!issuers.includes(payload.iss)) throw new Error(`bad issuer ${payload.iss}`);
  }
  if (audience !== undefined && payload.aud !== audience) throw new Error('bad audience');
  if (!payload.exp || payload.exp * 1000 < Date.now() - 60_000) throw new Error('expired id_token');
  if (nonce && payload.nonce !== nonce) throw new Error('nonce mismatch');
  return payload;
}

/**
 * Verify an ES256 OIDC id_token against a JWKS endpoint:
 * signature, issuer, audience, expiry and (optionally) nonce.
 */
export async function verifyOidcToken(
  token: string,
  { jwksUrl, issuer, audience, nonce }: { jwksUrl: string; issuer: string | string[]; audience: string; nonce?: string }
): Promise<Record<string, any>> {
  const keys = await fetchJwks(jwksUrl);
  return verifyEs256WithKeys(token, keys, { issuer, audience, nonce });
}
