# StoreMap 🛒🗺️

**An in-store product mapping web app.** Shoppers search a product and see exactly where
it is on an interactive, top-down 2D map of the store — on any device, with no app to
install. Store owners draw and edit their maps with a built-in browser editor and sign in
with **Google** or **Apple**.

```
┌────────────────────────────────────────────────────────────────┐
│  Shopper (any device)            Store owner                   │
│  /s/harbor-market                /dashboard                    │
│  search "milk" → pin on map      draw shelves, pin products    │
└───────────────┬──────────────────────────┬─────────────────────┘
                │        one origin        │
        ┌───────▼──────────────────────────▼───────┐
        │  Node.js + Express                        │
        │  · Google & Apple OAuth (OIDC, verified)  │
        │  · REST API  · SQLite  · static SPA       │
        └──────────────────────────────────────────┘
```

---

## Features

**For shoppers** — no account needed
- Public map page per store: `/s/<slug>` (link or printed QR code)
- **Full-screen immersive 3D** — the map fills the browser window behind a single
  floating search box (no menus, no panels); drag to orbit, scroll/pinch to zoom.
- Instant product search (name, brand, SKU, barcode, category) in the floating
  search box, results in a dropdown. The map preview stays clean — item markers
  appear only while searching, and the selected item's marker stays afterwards.
- **Item markers on the fixture** — a product's dot sits on the shelf face it is
  stocked against: on the shelf outline in 2D, on the shelf wall in 3D.
- **3D fly-through on demand** — selecting a product draws the walking route
  (A* on a 0.25 m nav grid built from the floor's shelves and walls, with a 0.3 m
  shopper clearance) straight away and resets the camera to the store's original
  angle; one tap on the **✈ Fly the route** button in the top bar sends the camera
  on an overhead drone flight down the path to the item, holding one constant
  angle from takeoff to arrival. Skip button included; touching the map takes
  manual control anytime. Toggling 2D↔3D keeps your 3D angle.
- **Route overlay everywhere** — the orange route + distance/walk-time badge
  stays on screen in both 3D and the classic 2D SVG view.
- **Lightweight 3D engine** — hand-rolled Canvas-2D projection + painter's
  algorithm with near-plane polygon clipping (geometry straddling the camera
  renders correctly instead of vanishing). Shelves look stocked: every pinned
  product draws a colored facing block on its shelf face. No WebGL, no three.js,
  a few KB of code, smooth on low-end devices.
- **Themes** — light/dark/system appearance for the whole app via the ◐ settings
  popover, saved per device. Dark mode restyles the whole UI **and the 3D map**
  (dim fixtures, dark backdrop, light labels).
- Multi-floor support, entrance/exit markers, tap a shelf (2D) to see its layout
- Aisle labels on the map (2D and 3D); hover an aisle's `≡` symbol for what's
  stocked along it
- Touch-first: one-finger pan, pinch zoom, two-finger drag to pan the 3D
  camera sideways; fully responsive

**For store owners** — Google / Apple sign-in
- Guided map editor with a **pick filter** — *Fixtures* selects shelves/walls/zones,
  *Products* selects and drags product pins without ever grabbing the floor or walls
- **Autosave history** — every minute of editing keeps a snapshot (max 20 per floor,
  auto-pruned); the History tab lists them as a changelog and restores any of them
  with one click
- Guided map editor: walls, shelves, aisles, zones, POIs
  - rectangles, polygons, polylines, points on a meter grid with snapping
  - move / resize / rotate (rotation handle, `R` key, or the panel's ° field),
    duplicate, undo–redo, keyboard shortcuts (`R`, `Del`, `Esc`)
  - **Aisle pair tool** — drag one shelf row and a facing row appears 1.5 m across
    the aisle, like a real grocery store
  - optional uploaded floor-plan image to trace over
  - debounced autosave — draw and it's saved
- Product catalogue with categories, prices, brands, SKUs
- Pin products to shelves; move them anytime
- **Shelf layout view** — tap a shelf on the public map (or “View shelf layout” in the
  editor) to see the actual front of the shelf: bays, levels, and each product's facing
  exactly where its map pin places it
- Publish toggle, public link, printable QR code
- Store profile: hours, address, phone, website, logo

**Product photos** (paid plan · included in local mode)
- Attach a photo to any product from the editor; shoppers see thumbnails in
  search results and the item sheet.
- Included with **local mode** (self-hosted: `SELF_HOSTED=true`); on hosted
  instances it requires the store's plan to be `pro`.

**Stock**
- Built-in stock tracking: per-product levels, adjust/set counts, full movement log
- CSV interchange: paste-import products/stock, export `catalog.csv`
- CSV interchange: paste-import products and stock counts from any spreadsheet or
  system, and export the catalog any time (`catalog.csv`)
- CSV export (`/api/stores/:id/catalog.csv`) in a standard interchange format
- **StockTrack API** — an independent, key-based tracking API (`/api/v1`) any third party
  (POS, e-commerce, scripts, even another StoreMap store) can use to read and update stock

## Quick start (local)

Requirements: **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
# 1. build the SPA once — the backend serves it from frontend/dist (not committed)
cd frontend
npm install
npm run build

# 2. backend
cd ../backend
npm install
npm run dev            # API + built frontend on http://localhost:8787

# frontend dev server, only while working on the UI
cd ../frontend
npm run dev            # Vite dev server on http://localhost:5173, proxies to 8787
```

For production use, build the SPA and let the backend serve it:

```bash
cd frontend && npm run build   # outputs frontend/dist
cd ../backend && npm start     # single origin on :8787
```

Without OAuth credentials configured, the login page offers a **local demo login**
(`ENABLE_DEV_LOGIN`, on by default outside production) so you can try everything
immediately — including a one-click **"Open the demo maps"** button that signs you
straight into the seeded demo stores, no form needed.

To fill the bundled demo store with a realistic layout — a 54×36 m supermarket with
stocked wall shelving around the border, double-sided gondola pairs facing each other
across aisles, a checkout area by the entrance, and **150 products** pinned to the
shelf faces:

```bash
cd backend && node scripts/seed-demo.mjs            # idempotent
node scripts/seed-demo.mjs --reset                  # rebuild from scratch
```

The same script also seeds **Annex Market** (`/s/annex-market`) — a
complex-shape example: an L-shaped hall with a loading-dock notch and an
attached backstock warehouse traced with polyline walls, labeled aisles in
both the hall and the warehouse, and 42 pinned products. Use
`--reset-annex` to rebuild just that one.

## Tests

A full test suite guards the mapping functionality so it won't break:

**Backend** (`node:test`, boots the real Express app + throwaway SQLite):

```bash
cd backend
npm test               # 39 tests: API integration (auth, ownership, CRUD, search, uploads)
                       # + stock tracking, API keys & the v1 API, adapter normalisation,
                       # CSV parser/round-trips, element validation units
npm run smoke          # boots the real server and walks the whole user journey
```

**Frontend** (Vitest + Testing Library, jsdom):

```bash
cd frontend
npm test               # 46 tests: coordinate transforms, hit-testing, resize/translate,
                       # shelf planogram computation, element parse/serialise,
                       # ShelfDetail component (bays, levels, facings, interactions),
                       # wayfinding (nav grid, A* around shelves, unreachable goals),
                       # 3D projection, box/route mesh building
```

The mapping core is covered on both sides: element validation (`test/validate.test.mjs`)
rejects malformed geometry server-side, while `geometry.test.ts` pins down the client-side
transform/hit-test math that drawing, selection and tapping rely on.

**End-to-end** (Playwright, boots the real server + built SPA):

```bash
cd e2e && npm ci && npx playwright install chromium && npm test
# 4 journeys: shopper search→route→2D/3D, multi-stop trips, OG meta, editor
# draw→autosave→history snapshots
```
CI runs all three suites on every push (`.github/workflows/ci.yml`).

## Deploying online

**Fastest path (Stage 0, ~15 min of account setup):** follow
[docs/DEPLOY.md](docs/DEPLOY.md) — Fly.io + Cloudflare (free CDN) + R2 media and
backups, ≈$6–8/month at launch. The scale plan behind it lives in
[docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md).

### 1. Configure environment

Copy [.env.example](.env.example) and set at minimum:

| Variable | Notes |
|---|---|
| `PUBLIC_BASE_URL` | Your public HTTPS origin, e.g. `https://map.myshop.com` |
| `SESSION_SECRET` | Long random string (generator command in the example file) |
| `NODE_ENV` | `production` |

### 2. Google sign-in (Google Cloud Console)

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials → Create credentials → OAuth client ID** (Web application)
2. Authorized redirect URI: `https://YOUR-DOMAIN/api/auth/google/callback`
3. Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

### 3. Apple sign-in (Apple Developer)

1. [developer.apple.com](https://developer.apple.com/account) → **Identifiers → ＋ → Services ID** (e.g. `com.yourco.storemap`); enable *Sign In with Apple*, set the return URL to `https://YOUR-DOMAIN/api/auth/apple/callback`
2. **Keys → ＋** → create a key with *Sign In with Apple*, download the `.p8` file and note the `Key ID`
3. Fill `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (paste the `.p8` contents — newlines as `\n`)

The server builds Apple's short-lived ES256 `client_secret` JWT automatically and
verifies every returned `id_token` against the provider's JWKS.

### 4. Run it

**Docker (recommended):**

```bash
export PUBLIC_BASE_URL=https://map.myshop.com
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
# …plus the OAuth variables from step 2/3 (or use an env file)
docker compose up -d --build
```

SQLite lives on the `storemap-data` volume (`/data`), together with uploaded floor-plan
images — back that volume up and you're done.

**Any Node host** (Fly.io, Render, Railway, a VPS with systemd, …):

```bash
cd frontend && npm ci && npm run build
cd ../backend && npm ci --omit=dev
NODE_ENV=production PUBLIC_BASE_URL=https://… SESSION_SECRET=… node src/index.js
```

Point a TLS-terminating proxy (Caddy/Nginx/your platform) at the port and set
`TRUST_PROXY=true`.

### Local mode & one-click deploy (self-hosting)

Run your own instance and every paid-tier feature — product photos — is
included:

1. Deploy this repo to any Node/Docker host (Railway reads `railway.json`;
   Fly uses `fly.toml`; Render reads `render.yaml` — one-click button:
   `https://render.com/deploy?repo=<your-github-repo-url>`; `docker compose up`
   works locally).
2. Set `SELF_HOSTED=true` (plus `SESSION_SECRET`, `PUBLIC_BASE_URL`,
   `TRUST_PROXY=true` behind a proxy) and mount `/data`. `docker-compose.yml`
   already defaults `SELF_HOSTED=true` and `SEED_DEMO=true`.
3. First boot with an empty database seeds the demo maps automatically
   (`SEED_DEMO=false` to skip). Sign in via **Open the demo maps** and edit —
   on a private instance that button needs `ENABLE_DEV_LOGIN=true` (production
   keeps passwordless logins off by default); public instances should
   configure Google/Apple OAuth instead.

A tutorial rendered inside the app itself lives at **`/self-host`**. For the
platform-by-platform commands, see
[docs/TUTORIAL-SELF-HOST.md](docs/TUTORIAL-SELF-HOST.md); Railway specifics:
[docs/HOSTING-RAILWAY.md](docs/HOSTING-RAILWAY.md).

### Health check

`GET /api/health` → `{"ok":true,…}` (used by the Docker HEALTHCHECK).

## Security notes

- Sessions: HMAC-signed, `httpOnly`, `SameSite=Lax`, `Secure` in production; 30-day expiry
- OAuth `state` + `nonce` round-tripped via short-lived cookies; `id_token` signature,
  issuer, audience, expiry and nonce all verified (Google JWKS / Apple JWKS)
- Every nested resource is ownership-checked server-side
- Parameterized SQL only; JSON body limit 2 MB; uploads limited to PNG/JPEG/WebP ≤ 10 MB
  with magic-byte validation; login endpoints rate-limited; standard hardening headers
- Never run with `ENABLE_DEV_LOGIN=true` in production

## Project layout

```
backend/            Express API + auth + SQLite (zero native deps)
  src/app.js        app factory  ·  src/index.js  bootstrap
  src/auth/         sessions, Google & Apple OIDC
  src/routes/       stores, floors/elements, catalog, public, uploads
  test/             API integration tests + smoke test
  scripts/          seed-demo.mjs — fills the demo store with a full layout
frontend/           React + TypeScript + Vite SPA
  src/components/   MapCanvas (SVG engine), Map3D (canvas 3D engine),
                    EditorPage, ViewerPage, Dashboard…
  src/lib/          geometry (2D transforms) · navgrid (A* wayfinding)
                    render3d (projection + painter's algorithm)
docs/PLAN.md        architecture & design decisions
docs/ARCHITECTURE.md deep technical reference — data model, API, both map engines,
                    camera/clip math, wayfinder, seeder, tests
docs/INFRASTRUCTURE.md hosting & scale plan — 100K maps worldwide, backups,
                    employee roles, warehouses, offline maps, cost model
docs/MOBILE-APPS.md  iOS + Android plan — Capacitor shells over this SPA,
                    barcode scan-to-route, push, store compliance
docs/CODE_REFERENCE.md function-level documentation of every backend/frontend file
docs/IMPROVEMENTS.md  the prioritized improvement backlog — review of every page
                     and subsystem with impact/effort ratings
```

## API overview

| Area | Endpoints |
|---|---|
| Auth | `GET /api/auth/{google,apple}` → provider · `…/callback` · `POST /api/auth/dev-login` · `GET /api/auth/me` · `POST /api/auth/logout` |
| Stores | `GET /api/stores/mine` · `POST /api/stores` · `PATCH/DELETE /api/stores/:id` · `GET /api/stores/:id/full` |
| Floors & map | `POST /api/stores/:id/floors` · `PATCH/DELETE /api/floors/:id` · `PUT /api/floors/:id/elements` (bulk autosave) · `GET /api/floors/:id/snapshots[/:id]` (autosave history) |
| Catalog | `POST /api/stores/:id/{categories,products}` · `PATCH/DELETE /api/{categories,products}/:id` · `POST /api/products/:id/locations` · `DELETE /api/locations/:id` |
| Public | `GET /api/public/stores?q=` · `GET /api/public/stores/:slug` · `GET /api/public/stores/:slug/search?q=` |
| Media | `POST /api/uploads` (raw image bytes) · served at `/uploads/*` |
| Stock (owner) | `GET /api/stores/:id/stock` · `POST /api/stores/:id/stock/{adjust,set}` · `GET/POST /api/stores/:id/keys` · `DELETE /api/stores/keys/:keyId` |
| CSV (owner) | `POST /api/stores/:id/integrations/csv` · `GET /api/stores/:id/catalog.csv` |
| Product images (owner) | `POST /api/products/:id/image` (raw bytes; paid plan or local mode) · `DELETE /api/products/:id/image` |
| StockTrack v1 (API key) | `GET /api/v1/store` · `GET /api/v1/products` · `GET /api/v1/stock` · `POST /api/v1/products` · `POST /api/v1/stock/{adjust,set}` · `GET /api/v1/map` |

### StockTrack v1 — independent tracking API

Any external system can integrate with just an API key (create one under
**Stock → Independent tracking API** in the dashboard):

```bash
# read stock
curl -H "Authorization: Bearer skm_…" https://your-host/api/v1/stock

# report a sale from any POS / system (also accepts X-API-Key)
curl -X POST -H "Authorization: Bearer skm_…" -H "Content-Type: application/json" \
  -d '{"sku":"MILK-2","delta":-1,"source":"my-pos"}' \
  https://your-host/api/v1/stock/adjust

# upsert products + stock in one call (matched by sku, then barcode, then name)
curl -X POST -H "X-API-Key: skm_…" -H "Content-Type: application/json" \
  -d '{"name":"Oat Milk 1L","sku":"OAT-1L","price":2.5,"quantity":14}' \
  https://your-host/api/v1/products
```

