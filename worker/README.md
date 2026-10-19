# StoreMap on Cloudflare Workers

A full port of the StoreMap backend to a **Cloudflare Worker**: Hono routes,
**D1** (SQLite) for data, an **R2** bucket for uploaded images, WebCrypto for
sessions/JWT, and the built SPA served from the assets CDN — one deployment,
one origin, same API the frontend already speaks.

The Express backend in `backend/` is untouched; this worker is a parallel
deployment target living in `worker/`.

## One-click deploy

Merge/push this branch, then use the **Deploy to Cloudflare** button on the
`/self-host` page (or open
`https://deploy.workers.cloudflare.com/?url=<your-repo-url>`).

The button reads [`wrangler.jsonc`](wrangler.jsonc) and provisions everything:

- **D1 database** `storemap` — schema migrations + the two demo stores apply
  automatically on first request (Freshmart Downtown, 150 pinned products;
  Annex Market, the complex-shape demo). No manual migration step.
- **R2 bucket** `storemap-media` — floor-plan images, logos, product photos.
- **Worker + assets** — the SPA from `frontend/dist` is served from the edge;
  only `/api/*`, `/uploads/*`, `/s/*` and SEO paths invoke the worker.

After the deploy you get a `https://storemap.<your-subdomain>.workers.dev`
URL — open it and press **“Open the demo maps — no sign-in”**.

## Configuration

Everything has a working default; no setup is required to try it:

| Setting | Default | Notes |
|---|---|---|
| `SELF_HOSTED` | `true` | local mode: product photos included, demo seeds on first boot |
| `ENABLE_DEV_LOGIN` | `true` | passwordless demo login. **Turn off for public instances** (`npx wrangler deploy` after editing, or via the dashboard) and configure Google/Apple instead |
| `PUBLIC_BASE_URL` | *(unset → request origin)* | canonical origin for share links + printed QR codes; set it to your custom domain when you attach one |
| `SESSION_SECRET` | *(unset → generated + stored in D1)* | auto-generated on first boot so sessions survive across isolates; override with `npx wrangler secret put SESSION_SECRET` for strict control |
| `GOOGLE_*` / `APPLE_*` | *(unset)* | OAuth sign-in; redirect URIs are `{PUBLIC_BASE_URL}/api/auth/{google,apple}/callback` |

## Verify locally

```bash
cd worker
npm install
npm run typecheck && npm test   # unit tests (crypto, validation, CSV, slugs)
npm run dev                     # wrangler dev — local D1 + R2 simulation
# first request migrates + seeds: open http://localhost:8787
```

## What changed vs the Node backend

The API surface and SQL are the same; the port is mechanical:

- **`node:sqlite` (sync) → D1 (async).** Every `db.prepare(...).get/all/run`
  became an awaited D1 call (`src/db.ts` helpers). Multi-statement
  transactions (`BEGIN/COMMIT`) became atomic `env.DB.batch([...])` calls —
  element autosave, store duplication and stock adjustments are still
  all-or-nothing (`resulting_quantity` is computed in SQL inside the batch).
- **`node:crypto` → WebCrypto.** Session HS256, Apple ES256 client_secret and
  OIDC id_token verification against Google/Apple JWKS all run on
  `crypto.subtle` (`src/crypto.ts`). Slug generation is byte-identical to the
  Node version (pinned by test).
- **Disk uploads → R2 binding.** `src/lib/storage.js`'s two backends collapse
  into one (`MEDIA.put/get`); magic-byte validation and immutable caching are
  preserved.
- **First boot** (`src/migrate.ts`) — migrations, a generated-and-persisted
  session secret, and demo seeding run once per fresh database, guarded
  against concurrent cold starts (unique slugs make a racing seed fail
  harmlessly).
- **Rate limiting** is per-isolate (best-effort burst control), not global.
- **No Litestream** — D1 has built-in point-in-time recovery (Time Travel);
  `wrangler d1 export` gives scheduled dumps if you want file backups.
- **Not ported:** address geocoding on store creation (optional in Node,
  env-gated) and the Cloudflare-zone CDN purge helper (workers.dev responses
  aren't edge-cached by default; a custom domain can add Cache Rules instead).

## Run the SPA against it during development

`npm run dev` serves the built `frontend/dist` at `http://localhost:8787`.
For hot-reloading UI work: `cd frontend && npm run dev` and point the Vite
proxy at the worker port (5173 config proxies `/api` to `:8787`).
