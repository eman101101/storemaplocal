# StoreMap Local 🛒🗺️

**Your own grocery map, self-hosted.** This is the self-hosting edition of
[StoreMap](https://github.com/eman101101/storemap): a setup-first layout that
walks you from sign-in to a published map, QR codes exported for **your site's
domain**, and a one-click **Cloudflare Workers** deploy (D1 database + R2 media,
free tier) — or run it on your own computer.

Open the app and the home page *is* the setup wizard:

```
┌─────────────────────────────────────────────────────────────┐
│  1 · Sign in            (one-click demo login / OAuth)      │
│  2 · Create your store  (inline form → editor)              │
│  3 · Draw the map & add products (autosave editor)          │
│  4 · Publish & export QR (PNG download / print, your domain)│
└─────────────────────────────────────────────────────────────┘
```

---

## ⚡ One-click deploy on Cloudflare (free tier)

Push this repo to GitHub (your fork works too), then click — or open:

> **https://deploy.workers.cloudflare.com/?url=https://github.com/eman101101/storemaplocal**

The button reads [`wrangler.jsonc`](wrangler.jsonc) and provisions everything:

- **D1 database** (`storemap`) — schema + two demo stores (a 150-product
  supermarket and a complex L-shaped market) seed themselves on first visit
- **R2 bucket** (`storemap-media`) — floor plans, logos, product photos
- **Worker + edge assets** — `https://storemap.<you>.workers.dev`, always on

Then just sign in (demo login is on by default) and start drawing.

<details>
<summary><b>Sign-in options</b> — pick one</summary>

- **Demo login (default, zero setup)** — "Open the demo maps — no sign-in".
  Turn it off (`ENABLE_DEV_LOGIN=false` in `wrangler.jsonc`) before going public.
- **Google / Apple OAuth** — implemented; set the `GOOGLE_*` / `APPLE_*`
  secrets and match the redirect URI (`/api/auth/google/callback`).
- **Cloudflare Access (built-in, free ≤ 50 users)** — protect the dashboard +
  owner API paths with an Access application, set `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUD`, and the worker trusts the edge-verified assertion. Details in
  [worker/README.md](worker/README.md).

</details>

<details>
<summary><b>Manual deploy / local dev of the Worker</b></summary>

```bash
npx wrangler dev       # local D1 + R2 simulation → http://localhost:8787
npx wrangler deploy    # deploy to your account
```

</details>

---

## 💻 Run it on your computer (no cloud)

Requirements: **Node.js ≥ 22.5** (uses the SQLite built into Node).

```bash
git clone https://github.com/eman101101/storemaplocal.git
cd storemaplocal

# 1. build the web UI once (the backend serves it)
cd frontend && npm install && npm run build

# 2. start the server — http://localhost:8787
cd ../backend
npm install
SELF_HOSTED=true npm start
```

Open http://localhost:8787 — the setup home appears, demo stores included.
Docker instead: `docker compose up -d --build` (create a `.env` with a
`SESSION_SECRET` first — the generator button on `/self-host` makes one).

**Put localhost online, free:** `cloudflared tunnel --url http://localhost:8787`
(zero signup, disposable URL) or `ngrok http --domain=your-name.ngrok-free.app
8787` (stable URL — use this for printed QR codes). Restart the server with
`PUBLIC_BASE_URL=https://your-tunnel-url TRUST_PROXY=true` so exported QR codes
match.

---

## Runaway protection

A daily circuit breaker caps R2 media operations (`R2_DAILY_BUDGET` in
`wrangler.jsonc`, default 25,000/day — roughly 5× a heavy store). Past the
budget, images and uploads pause with a friendly placeholder until the next
day while the map, search and editor keep running — so a bot can never turn
into an R2 overage charge. Set the budget to `"0"` to disable the breaker.

## QR codes

Every store card on the home page exports a QR encoding
`<your-site-domain>/s/<store-slug>` — the server-canonical URL, so codes keep
working on whatever domain you deploy to. **⬇ Download PNG** for print
materials, or open it and print directly.

## More

- Full self-hosting tutorial in the app: **`/self-host`** (or
  [worker/README.md](worker/README.md) for Cloudflare specifics)
- Backups: D1 point-in-time recovery / `wrangler d1 export` on Cloudflare;
  copy `backend/data/` locally; Litestream→R2 via `R2_*` env vars in Docker
- The hosted product and full architecture docs live in the
  [main StoreMap repo](https://github.com/eman101101/storemap)

## Tests

```bash
npm test --prefix frontend   # 91 tests — maps, wayfinding, 3D, editor
npm test  --prefix backend   # 38 tests — API, auth, stock, CSV
npm test  --prefix worker    # 23 tests — crypto, Access JWTs, validation, CSV
```
