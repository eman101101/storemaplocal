import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../App';
import type { StoreSummary } from '../types';

/**
 * StoreMap Local — the setup-first home for self-hosted instances.
 * Different layout from the public landing: a working checklist that walks the
 * owner from sign-in to a published map, with QR codes for the site domain.
 */

const SITE = window.location.origin;

export default function LocalHome() {
  const { user, providers, refresh } = useAuth();

  const demoLogin = async () => {
    await api.demoLogin();
    await refresh();
  };

  return (
    <main className="lh">
      <section className="lh-hero">
        <div className="lh-hero-copy">
          <span className="lh-kicker">StoreMap Local · {SITE.replace(/^https?:\/\//, '')}</span>
          <h1>
            Set up your map, <em>print your QR</em>
          </h1>
          <p>
            This is your own StoreMap instance. Work through the steps — sign in, create your store,
            draw the map, add products — then hand shoppers the QR code. It encodes this site's
            domain, so every code you export works on your URL.
          </p>
        </div>
      </section>

      <div className="lh-grid">
        <section className="card lh-step">
          <span className="num">{user ? '✓' : '1'}</span>
          <h4>Sign in</h4>
          {user ? (
            <p className="lh-ok">
              Signed in as <b>{user.name || user.email}</b>.
            </p>
          ) : (
            <div className="stack">
              {providers.dev && (
                <button className="btn primary block" onClick={demoLogin}>
                  🗺️ Open the demo maps — one click
                </button>
              )}
              <Link to="/login" className="btn block">
                Sign in (demo, Google or Apple)
              </Link>
            </div>
          )}
        </section>

        <section className="card lh-step">
          <span className="num">2</span>
          <h4>Create your store</h4>
          {user ? <CreateStore /> : <p>Sign in first — then a quick form puts your store on this instance.</p>}
        </section>

        <section className="card lh-step">
          <span className="num">3</span>
          <h4>Draw the map &amp; add products</h4>
          <p>
            In the editor: trace walls and shelf rows (the aisle-pair tool stamps the facing row),
            then drop product pins on the shelf faces. Autosave keeps everything.
          </p>
        </section>

        <section className="card lh-step">
          <span className="num">4</span>
          <h4>Publish &amp; export your QR</h4>
          <p>
            Flip the store to public in the editor, then export the QR below — it points shoppers at{' '}
            <code>{SITE}</code>.
          </p>
        </section>
      </div>

      {user && (
        <section className="lh-stores">
          <h2 className="section-title">Your stores — scan, download or print</h2>
          <StoreList />
        </section>
      )}
    </main>
  );
}

function CreateStore() {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { store } = await api.createStore({ name, address });
      setCreated(store.id);
      setName('');
      setAddress('');
      window.dispatchEvent(new Event('storemap:stores-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the store');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="stack">
        <p className="lh-ok">Store created — ready to draw.</p>
        <Link className="btn primary block" to={`/dashboard/stores/${created}`}>
          Open the editor →
        </Link>
        <button className="btn block" onClick={() => setCreated(null)}>
          + Another store
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <input className="input" placeholder="Store name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input className="input" placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} />
      {error && <div className="error-note">{error}</div>}
      <button className="btn primary block" disabled={busy || !name.trim()}>
        {busy ? 'Creating…' : 'Create store'}
      </button>
    </form>
  );
}

function StoreList() {
  const [stores, setStores] = useState<StoreSummary[] | null>(null);

  const load = useCallback(() => {
    api.myStores().then((r) => setStores(r.stores)).catch(() => setStores([]));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    window.addEventListener('storemap:stores-changed', load);
    return () => window.removeEventListener('storemap:stores-changed', load);
  }, [load]);

  if (stores === null) return <p className="muted">Loading your stores…</p>;
  if (!stores.length)
    return (
      <div className="empty-state card">
        <p>No stores yet — create one in step 2 above.</p>
      </div>
    );
  return (
    <div className="lh-qr-grid">
      {stores.map((s) => (
        <StoreQrCard key={s.id} store={s} />
      ))}
    </div>
  );
}

/** QR for the store's public URL on this site's domain, with PNG export. */
function StoreQrCard({ store }: { store: StoreSummary }) {
  const [src, setSrc] = useState('');
  const url = store.shareUrl || `${SITE}/s/${store.slug}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await QRCode.toDataURL(url, {
        width: 380,
        margin: 1,
        errorCorrectionLevel: 'H',
        color: { dark: '#1d2a20', light: '#ffffff' },
      });
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 380;
        const ctx = c.getContext('2d');
        if (!ctx || cancelled) return;
        ctx.drawImage(img, 0, 0, 380, 380);
        ctx.fillStyle = '#fff';
        ctx.fillRect(159, 159, 62, 62);
        ctx.fillStyle = '#2f6f3e';
        ctx.font = '700 34px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('▦', 190, 192);
        if (!cancelled) setSrc(c.toDataURL('image/png'));
      };
      img.src = raw;
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="card lh-qr">
      <div className="lh-qr-img">{src ? <img src={src} alt={`QR code for ${store.name}`} /> : <div className="lh-qr-placeholder" />}</div>
      <div className="lh-qr-info">
        <h3>
          {store.name}{' '}
          <span className={`badge ${store.is_public ? '' : 'gray'}`}>{store.is_public ? 'Public' : 'Draft'}</span>
        </h3>
        <code className="lh-qr-url">{url}</code>
        <p className="muted">
          {store.product_count ?? 0} product{(store.product_count ?? 0) === 1 ? '' : 's'} · {store.floor_count ?? 1} floor
          {(store.floor_count ?? 1) === 1 ? '' : 's'}
        </p>
        <div className="lh-qr-actions">
          <a className="btn sm primary" href={src} download={`storemap-${store.slug}-qr.png`}>
            ⬇ Download PNG
          </a>
          <a className="btn sm" href={src} target="_blank" rel="noreferrer">
            🖨 Open to print
          </a>
          <Link className="btn sm" to={`/dashboard/stores/${store.id}`}>
            ✏️ Edit
          </Link>
        </div>
        {!store.is_public && (
          <p className="muted" style={{ marginTop: 8 }}>
            Draft — publish it in the editor before printing; the link only works once public.
          </p>
        )}
      </div>
    </div>
  );
}
