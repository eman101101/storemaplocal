# Tutorial — Self-host StoreMap with one-click deploys (non-Vercel platforms)

StoreMap is a single Node.js process with a SQLite file — perfect for
self-hosting. In **local mode** (`SELF_HOSTED=true`) every paid-tier feature
(product photos) is included, and the first boot seeds demo maps so your
instance is usable the moment it goes live.

A version of this tutorial rendered inside the app lives at **`/self-host`**
(covering running it on your own machine first, then the online options below).

## Warm-up: run it on your machine first

```bash
# Node ≥ 22.5 — build the UI once, then start the server
cd frontend && npm install && npm run build
cd ../backend && npm install
SELF_HOSTED=true npm start        # → http://localhost:8787
```

Or with Docker (compose defaults `SELF_HOSTED=true` and `SEED_DEMO=true`;
generate a `SESSION_SECRET` and, on a private machine,
`ENABLE_DEV_LOGIN=true` for the one-click login):

```bash
printf 'SESSION_SECRET=%s\nENABLE_DEV_LOGIN=true\n' \
  "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" > .env
docker compose up -d --build      # → http://localhost:8787
```

## Free public URL from your own machine (tunnel)

No server budget? Give your machine a public https address with a tunnel and
keep the data local:

```bash
# zero signup, disposable address (Cloudflare quick tunnel)
cloudflared tunnel --url http://localhost:8787     # → https://….trycloudflare.com

# or a stable free address — the one to print QR codes for
ngrok http --domain=your-name.ngrok-free.app 8787  # static domain on the free plan
```

Then restart the backend with the public origin so share links and QR codes
match: `PUBLIC_BASE_URL=https://<tunnel-url> TRUST_PROXY=true npm start`.
Quick tunnels change address on every run; a named Cloudflare tunnel (needs a
domain, still free) or Tailscale Funnel gives a permanent one. The instance is
public now — configure Google/Apple OAuth and leave dev login off.

---

Pick one platform below. All of them: set a few env vars, mount one volume at
`/data`, done.

---

## What every platform needs

| Setting | Value |
|---|---|
| Env `NODE_ENV` | `production` |
| Env `SESSION_SECRET` | long random string (see below) |
| Env `PUBLIC_BASE_URL` | your public HTTPS url, e.g. `https://map.example.com` |
| Env `SELF_HOSTED` | `true` — enables local mode (default in `docker-compose.yml`) |
| Env `TRUST_PROXY` | `true` when the platform terminates TLS (all three below do) |
| Volume | mount at **`/data`** (SQLite + uploaded images live here) |
| Port | the app reads `PORT` (defaults to 8787) |

Generate the secret once:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

First boot with an empty database automatically seeds the demo maps
(set `SEED_DEMO=false` to skip). Sign in with the **Open the demo maps**
button on `/login` and start editing — on a public deployment that button
requires `ENABLE_DEV_LOGIN=true` (private instances only) or configure
Google/Apple OAuth instead.

> Rule of thumb: never scale past **one replica** — SQLite is single-writer
> and the volume is per-machine.

---

## Option A — Railway (most one-click)

Railway reads the `railway.json` in this repo: Dockerfile build,
`/api/health` healthcheck, single replica.

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub
   repo** → pick the repo. Railway detects the Dockerfile — no build config.
3. Service → **Settings → Volumes → New Volume**, mount path **`/data`**.
4. **Variables** tab → add the table above.
5. **Settings → Networking → Generate Domain** → put that url into
   `PUBLIC_BASE_URL`. Every push to `main` now auto-deploys.

CLI alternative: `npm i -g @railway/cli && railway login && railway init && railway up`,
then attach the volume in the dashboard.

Cost: Pro $20/mo (includes $20 usage — this app uses ~$6–12) — Pro is
required for volume backups; Hobby caps volumes at 5 GB.

## Option B — Fly.io (config already in the repo)

`fly.toml`, the Dockerfile and the Litestream backup wiring are all checked in.

```bash
brew install flyctl && fly auth login
fly launch --no-deploy          # accepts the checked-in fly.toml
fly volumes create storemap_data --size 3 --region iad
fly secrets set NODE_ENV=production SELF_HOSTED=true \
  SESSION_SECRET=<secret> PUBLIC_BASE_URL=https://<app>.fly.dev TRUST_PROXY=true
fly deploy
```

Cost: ≈ $6/mo. Optional: Cloudflare R2 for continuous SQLite backups
(`R2_*` secrets) — see `docs/DEPLOY.md`.

## Option C — Cloudflare Workers (the `storemaplocal` repo)

A full Workers port lives in the [`storemaplocal` repo](https://github.com/eman101101/storemaplocal) (`worker/`):
Hono + **D1** database + **R2** media + the SPA from the edge. Free tier,
persistent, one-click via the Deploy-to-Cloudflare button, and Cloudflare
Access (free ≤50 users) can serve as the sign-in. See `worker/README.md`
on that branch.

## Option D — Your own VPS + Cloudflare (full control)

```bash
# on the server (Ubuntu example)
git clone <your-fork> && cd storemap
docker compose up -d --build
```

`docker-compose.yml` already mounts the `storemap-data` volume and reads the
env file — create `.env` next to it with the table above. Then put
Cloudflare in front:

1. Add your domain to Cloudflare, point an A/AAAA record (or an origin
   certificate + tunnel) at the server.
2. `cloudflared tunnel` if you don't want open ports:
   `cloudflared tunnel create storemap` → route it to `http://localhost:8787`.
3. Set `PUBLIC_BASE_URL=https://map.example.com` and restart.

## After first boot

1. Open your url → the demo maps are on the front page (local mode seeded them).
2. `/login` → **Open the demo maps** to edit them, or create your own store.
3. Back it up: copy the volume's `storemap.db` (or wire Litestream → R2 with
   the `R2_*` env vars — replication every 10 s).

---

### Why not Vercel/Netlify?

They're serverless with an ephemeral filesystem — there is nowhere for the
SQLite file or uploaded images to live, and no long-running Express process.
Every platform above gives you the two things StoreMap needs: a persistent
`/data` volume and a always-on process.
