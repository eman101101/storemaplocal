import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/* Copy-to-clipboard helpers ------------------------------------------------ */

function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard unavailable (permissions) — the text is on screen anyway */
    });
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return { copied, copy };
}

function CodeBlock({ children }: { children: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="tut-code">
      <button className="tut-copy" onClick={() => copy(children)}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** 48 random bytes, base64url — the same recipe as the README's one-liner. */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function SecretRow() {
  const { copied, copy } = useCopy();
  const [secret, setSecret] = useState('');
  return (
    <div className="tut-code">
      {secret ? (
        <>
          <button className="tut-copy" onClick={() => copy(secret)}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <pre>{secret}</pre>
        </>
      ) : (
        <button className="btn sm tut-gen" onClick={() => { const s = generateSecret(); setSecret(s); copy(s); }}>
          🔑 Generate a secret (and copy it)
        </button>
      )}
    </div>
  );
}

/* One-click deploy button -------------------------------------------------- */

function CloudflareButton() {
  const [repo, setRepo] = useState('https://github.com/you/storemap');
  const repoTrim = repo.trim().replace(/\.git$/, '');
  const repoOk = /^https:\/\/\S+/.test(repoTrim);
  return (
    <div className="tut-deploy">
      <label className="field">
        <span>Paste the GitHub URL of <b>your copy</b> of this repo (with the <code>cloudflare-deploy</code> branch merged)</span>
        <input
          className="input"
          type="url"
          placeholder="https://github.com/you/storemap"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
      </label>
      <div className="tut-deploy-btns">
        {repoOk ? (
          <a className="btn primary tut-deploy-btn" href={`https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repoTrim)}`} target="_blank" rel="noreferrer">
            🚀 Deploy to Cloudflare (free)
          </a>
        ) : (
          <span className="muted">Add a https:// repo URL to light up the Cloudflare button.</span>
        )}
      </div>
    </div>
  );
}

/* Page --------------------------------------------------------------------- */

export default function SelfHost() {
  return (
    <main className="container">
      <article className="tut">
        <header className="tut-head">
          <h1>
            Host your own grocery map <em>for free</em>
          </h1>
          <p>
            StoreMap is one small Node.js process with one SQLite file — no databases to install, no
            services to wire up. Self-host it and you get everything, including the paid-tier features:
            product photos are always included in local mode. Two ways to get there — both free, both
            with real sign-in.
          </p>
        </header>

        <nav className="tut-paths">
          <a href="#local" className="card tut-path">
            <span className="num">1</span>
            <b>Your computer, online</b>
            <span>Run it, then borrow a free public https address. Full-featured, real data.</span>
          </a>
          <a href="#cf" className="card tut-path">
            <span className="num">2</span>
            <b>Cloudflare, always on</b>
            <span>One click to Workers + D1 — free tier, persistent, 24/7.</span>
          </a>
        </nav>

        <h3 className="tut-choose-title">Which one is for me?</h3>
        <div className="card tut-table-wrap">
          <table className="tut-table tut-choose">
            <thead>
              <tr><th>Way to host</th><th>Cost</th><th>Map survives restarts?</th><th>Best for</th></tr>
            </thead>
            <tbody>
              <tr><td>1 · Your computer</td><td>free</td><td>yes</td><td>trying it, drawing your map</td></tr>
              <tr><td>1 · Your computer + free tunnel</td><td>free</td><td>yes</td><td>real shoppers at $0 — while the computer is on</td></tr>
              <tr><td>2 · Cloudflare Workers (one click)</td><td>free tier</td><td>yes — data lives in D1</td><td>always-on at $0</td></tr>
            </tbody>
          </table>
        </div>

        {/* -------------------------------------------------------------- */}
        <section id="local">
          <h2>1 · Run it on your computer — and put it online, free</h2>
          <p>
            You need <b>Node.js 22.5 or newer</b> — check with <code>node --version</code> (it uses the
            SQLite database built into Node, so there is nothing else to install).
          </p>
          <CodeBlock>{`# 1. get the code (clone this repo, or download and unzip it)
git clone https://github.com/you/storemap.git
cd storemap

# 2. build the web UI once — the backend serves it as static files
cd frontend
npm install
npm run build

# 3. start the server
cd ../backend
npm install
SELF_HOSTED=true npm start`}</CodeBlock>
          <p>
            Open <code>http://localhost:8787</code> — the landing page already lists the demo stores
            (the first boot with <code>SELF_HOSTED=true</code> fills an empty database automatically).
            Go to <Link to="/login">/login</Link> and press{' '}
            <b>“Open the demo maps — no sign-in”</b> to edit them, no account needed. Your data lives
            in <code>backend/data/</code>; delete it for a factory reset.
          </p>

          <h3>Real sign-in locally (optional)</h3>
          <p>
            The passwordless demo login is on by default. Prefer real accounts? The backend reads{' '}
            <code>backend/.env</code> — create it once and Google sign-in works locally:
          </p>
          <CodeBlock>{`# backend/.env
SELF_HOSTED=true
ENABLE_DEV_LOGIN=false            # turn the passwordless door off
PUBLIC_BASE_URL=http://localhost:8787
GOOGLE_CLIENT_ID=<from console.cloud.google.com>
GOOGLE_CLIENT_SECRET=<same place>

# in the Google console → Credentials → OAuth client ID (Web application):
#   Authorized redirect URI: http://localhost:8787/api/auth/google/callback`}</CodeBlock>
          <p>
            Restart <code>npm start</code> and sign in with Google. Apple sign-in works the same way
            (its setup lives in the README). On the Cloudflare deployment there's a third option —
            Cloudflare Access — covered below.
          </p>

          <h3>Now give it a public address — a free tunnel</h3>
          <p>
            Happy with your map and want shoppers to reach it? A <b>tunnel</b> gives your machine a
            public https address that forwards to <code>localhost:8787</code>. Two free ways:
          </p>
          <p><b>A · Zero signup, disposable URL</b> (Cloudflare quick tunnel):</p>
          <CodeBlock>{`brew install cloudflared        # macOS — Linux/Windows: download from
                                # github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:8787
# → prints a public https://….trycloudflare.com address — open it, done`}</CodeBlock>
          <p><b>B · A URL that never changes</b> (ngrok's free static domain) — the one to use if you
            print QR codes:</p>
          <CodeBlock>{`brew install ngrok                             # then sign up free at ngrok.com
ngrok config add-authtoken <token-from-dashboard>
ngrok http --domain=your-name.ngrok-free.app 8787`}</CodeBlock>
          <p>
            Then restart the server with the public address, so share links and printed QR codes match
            the tunnel:
          </p>
          <CodeBlock>{`cd backend
PUBLIC_BASE_URL=https://your-tunnel-url TRUST_PROXY=true npm start`}</CodeBlock>
          <div className="tut-callout warn">
            <b>Heads-up:</b> the tunnel makes the whole site public. Keep dev login off and set up
            Google/Apple sign-in (README, “Deploying online”) so only you can edit. Quick tunnels
            (<i>…trycloudflare.com</i>) get a new address every run — use option B for anything you
            print. And the map is only online while your computer is.
          </div>
          <p className="muted">
            Already have a domain on Cloudflare? A named tunnel (<code>cloudflared tunnel create</code>)
            gives you a stable address on your own domain for free. On a tailnet?{' '}
            <code>tailscale funnel</code> does the same.
          </p>
          <div className="tut-callout">
            <b>Notes</b>
            <ul>
              <li>
                Skip <code>SELF_HOSTED=true</code> and everything still runs — you just get an empty
                instance. Fill it with the demo maps anytime:{' '}
                <code>node scripts/seed-demo.mjs</code> (idempotent, <code>--reset</code> rebuilds).
              </li>
              <li>
                Editing the UI while developing? Run <code>npm run dev</code> in <code>frontend/</code>{' '}
                instead — a hot-reloading server on port 5173 that proxies to 8787.
              </li>
            </ul>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        <section id="cf">
          <h2>2 · Cloudflare Workers — always on, free tier, one click</h2>
          <p>
            The <code>cloudflare-deploy</code> branch adds a full Cloudflare port: a Worker (Hono) with{' '}
            <b>D1</b> as the database, <b>R2</b> for uploaded images, and the web app served from the
            edge — one deployment, always online, on Cloudflare's free tier. The deploy button reads
            the repo's <code>wrangler.jsonc</code> and provisions D1 + R2 automatically; the demo maps
            seed themselves on the first visit.
          </p>
          <CloudflareButton />
          <div className="card tut-table-wrap">
            <table className="tut-table">
              <tbody>
                <tr><td>Cost</td><td>free tier — Workers free plan covers a small store's traffic</td></tr>
                <tr><td>You get</td><td><code>storemap.&lt;you&gt;.workers.dev</code> URL, D1 database, R2 bucket — all provisioned by the button</td></tr>
                <tr><td>Persists?</td><td><b>yes</b> — D1 is a real database; the map survives restarts and redeploys (point-in-time recovery included)</td></tr>
                <tr><td>QR codes</td><td>set <code>PUBLIC_BASE_URL</code> to a custom domain when you attach one (it defaults to the workers.dev origin)</td></tr>
              </tbody>
            </table>
          </div>

          <h3>Sign-in — three ways, pick one</h3>
          <div className="tut-callout">
            <ul>
              <li>
                <b>Demo login (default, zero setup).</b> “Open the demo maps — no sign-in” works out
                of the box. Great while you evaluate; turn it off before going public.
              </li>
              <li>
                <b>Google / Apple sign-in (≈15 min).</b> Already implemented — create OAuth
                credentials, set them as Worker secrets, and match the redirect URI. Same recipe as
                the local option above, with your public URL.
              </li>
              <li>
                <b>Cloudflare Access — the built-in option.</b> Protect the dashboard + owner API
                paths with an <Link to="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Access</Link>{' '}
                application (email OTP, Google, GitHub… — free for up to 50 users). Set{' '}
                <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> on the worker and it
                verifies the signed assertion the edge injects, mapping your email to the owner
                account — sign-in with <b>zero code</b> and no OAuth console setup.
              </li>
            </ul>
          </div>
          <p className="muted">
            This port lives on the <code>cloudflare-deploy</code> branch — merge it (or deploy directly
            from the branch) to use the button. Full details, including the Access setup, in{' '}
            <code>worker/README.md</code>. Prefer managing it yourself?{' '}
            <code>cd worker && npx wrangler deploy</code> does the same thing from your terminal.
          </p>
        </section>

        {/* -------------------------------------------------------------- */}
        <section id="firstboot">
          <h2>3 · First boot — make it yours</h2>
          <ol className="tut-steps">
            <li>
              <b>Open your URL.</b> A fresh instance seeds itself with two demo stores — a full
              supermarket and a complex L-shaped market — so there's something to explore immediately.
            </li>
            <li>
              <b>Sign in</b> at <code>/login</code>. On a private instance, “Open the demo maps” drops
              you straight into the editor. Public instance? Use your Google/Apple account.
            </li>
            <li>
              <b>Create your store</b> from the dashboard: name, address, opening hours.
            </li>
            <li>
              <b>Draw the map:</b> trace walls, drag shelf rows (the aisle pair tool stamps the facing
              row across the aisle in one gesture), drop product pins on the shelf faces.
            </li>
            <li>
              <b>Publish</b> and print the QR code. Shoppers open the link and search — no app, no
              account, route straight to the item.
            </li>
          </ol>
        </section>

        {/* -------------------------------------------------------------- */}
        <section id="backups">
          <h2>4 · Keep your data safe</h2>
          <p>
            Everything that matters sits in one place: <code>storemap.db</code> plus the{' '}
            <code>uploads/</code> directory locally (<code>backend/data/</code>), the{' '}
            <code>/data</code> volume in Docker — or the D1 database + R2 bucket on Cloudflare. Back
            it up and you're done:
          </p>
          <CodeBlock>{`# simple and good enough: stop the server, copy the folder
docker compose cp storemap:/data ./backup      # Docker
# …or just copy backend/data/ on a bare install`}</CodeBlock>
          <p>
            For continuous backups, the Docker image has Litestream built in (set the four{' '}
            <code>R2_*</code> env vars), and the Cloudflare deployment has D1's point-in-time
            recovery built in — <code>npx wrangler d1 export</code> gives you a file anytime.
          </p>
        </section>

        {/* -------------------------------------------------------------- */}
        <section id="trouble">
          <h2>Troubleshooting</h2>
          <div className="tut-faq">
            <div className="card tut-qa">
              <b>The server exits immediately: “SESSION_SECRET must be set when NODE_ENV=production”</b>
              <p>
                Production mode refuses to run without a signing secret. Generate one and pass it via
                the environment or your <code>.env</code> file.
              </p>
            </div>
            <div className="card tut-qa">
              <b>No sign-in buttons, or “Demo login is disabled”</b>
              <p>
                In production the passwordless logins are off unless{' '}
                <code>ENABLE_DEV_LOGIN=true</code> — fine on a private machine. On a public instance,
                configure Google/Apple OAuth instead so only real accounts get in.
              </p>
            </div>
            <div className="card tut-qa">
              <b>My trycloudflare.com URL changed / the printed QR code stopped working</b>
              <p>
                Quick tunnels are disposable — a new address every run. For a QR you can print, use
                ngrok's free static domain (section 1B) or a named Cloudflare tunnel on your own domain.
              </p>
            </div>
            <div className="card tut-qa">
              <b>I turned on Cloudflare Access but the dashboard still asks me to sign in</b>
              <p>
                Access authenticates you at Cloudflare's edge; the worker then maps your verified
                email to an owner account. Set <code>ACCESS_TEAM_DOMAIN</code> (and ideally{' '}
                <code>ACCESS_AUD</code>) on the worker so it trusts the assertion — see the table in
                section 2.
              </p>
            </div>
            <div className="card tut-qa">
              <b>The landing page is empty</b>
              <p>
                A fresh database has no public stores until the demo seed runs (automatic with{' '}
                <code>SELF_HOSTED=true</code>, or <code>node scripts/seed-demo.mjs</code>) or you publish
                your own — that's normal, not a bug.
              </p>
            </div>
            <div className="card tut-qa">
              <b>Port 8787 serves an API error / blank page</b>
              <p>
                The backend serves the web UI from <code>frontend/dist</code>, which isn't committed to
                git. Build it once: <code>cd frontend && npm install && npm run build</code>.
              </p>
            </div>
          </div>
        </section>

        <footer className="tut-foot">
          Deeper reference: <code>README.md</code> (deployment &amp; security),{' '}
          <code>docs/TUTORIAL-SELF-HOST.md</code> (more platforms — Railway, Fly, VPS),{' '}
          <code>docs/ARCHITECTURE.md</code> (how it all works).
          <div className="hero-actions" style={{ marginTop: 18 }}>
            <Link to="/" className="btn primary">Browse the demo maps</Link>
            <Link to="/login" className="btn">Sign in and build your map</Link>
          </div>
        </footer>
      </article>
    </main>
  );
}
