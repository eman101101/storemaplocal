/** Feature entitlements (port of backend/src/lib/entitlements.js). */

export function entitlementsFor(config: { selfHosted: boolean }, store: { plan?: string | null }) {
  return {
    productImages: config.selfHosted || store.plan === 'pro',
  };
}

export function productImagesEnabled(config: { selfHosted: boolean }, store: { plan?: string | null }): boolean {
  return entitlementsFor(config, store).productImages;
}
