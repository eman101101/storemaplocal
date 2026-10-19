import { describe, it, expect } from 'vitest';
import { decodeJwt, verifyEs256WithKeys, signHs256, verifyHs256, signEs256 } from '../src/crypto';
import { toB64Url, utf8 } from '../src/util';

/** Craft a minimal ES256 JWKS + signed token, the way Cloudflare Access does. */
async function makeAccessFixture(claims: Record<string, unknown>, kid = 'test-key') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const jwks = [{ ...jwk, kid, alg: 'ES256', use: 'sig' }];
  const header = toB64Url(utf8(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const body = toB64Url(utf8(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(signingInput));
  return { jwks, token: `${signingInput}.${toB64Url(new Uint8Array(sig))}` };
}

const baseClaims = {
  iss: 'https://myteam.cloudflareaccess.com',
  aud: 'my-aud-tag.access',
  email: 'Owner@Example.com',
  name: 'Evan',
  exp: Math.floor(Date.now() / 1000) + 300,
};

describe('Cloudflare Access token verification', () => {
  it('verifies a well-formed Access JWT and returns claims', async () => {
    const { jwks, token } = await makeAccessFixture(baseClaims);
    const claims = await verifyEs256WithKeys(token, jwks, {
      issuer: 'https://myteam.cloudflareaccess.com',
      audience: 'my-aud-tag.access',
    });
    expect(claims.email.toLowerCase()).toBe('owner@example.com');
  });

  it('rejects a token signed by another key', async () => {
    const a = await makeAccessFixture(baseClaims);
    const b = await makeAccessFixture(baseClaims); // different keypair
    await expect(
      verifyEs256WithKeys(a.token, b.jwks, { issuer: 'https://myteam.cloudflareaccess.com' })
    ).rejects.toThrow('bad id_token signature');
  });

  it('rejects a wrong issuer', async () => {
    const { jwks, token } = await makeAccessFixture(baseClaims);
    await expect(
      verifyEs256WithKeys(token, jwks, { issuer: 'https://other.cloudflareaccess.com' })
    ).rejects.toThrow('bad issuer');
  });

  it('rejects a wrong audience when one is configured', async () => {
    const { jwks, token } = await makeAccessFixture(baseClaims);
    await expect(
      verifyEs256WithKeys(token, jwks, { audience: 'someone-elses-aud' })
    ).rejects.toThrow('bad audience');
  });

  it('rejects expired tokens (beyond the 60s clock leeway)', async () => {
    const { jwks, token } = await makeAccessFixture({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifyEs256WithKeys(token, jwks, {})).rejects.toThrow('expired');
  });

  it('decodes the Access header/payload shape', async () => {
    const { token } = await makeAccessFixture(baseClaims);
    const { header } = decodeJwt(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('test-key');
  });
});

describe('HS256 sessions', () => {
  it('still signs and verifies', async () => {
    const token = await signHs256({ sub: 'u1' }, 's');
    expect((await verifyHs256(token, 's')).sub).toBe('u1');
  });
});

describe('ES256 signing (Apple client_secret)', () => {
  it('produces a decodable ES256 token', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
    const token = await signEs256({ iss: 'team', exp: 1 }, pem, 'kid');
    const { header, payload } = decodeJwt(token);
    expect(header.alg).toBe('ES256');
    expect(payload.iss).toBe('team');
  });
});
