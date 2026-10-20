import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../App';
import { Modal, Field } from './ui';
import type { StoreSummary } from '../types';

/** Stable per-store accent color for the card header strip. */
const ACCENTS = ['#2f6f3e', '#3b6fd4', '#c47f17', '#7c3aed', '#b0413e', '#2f8a7d'];

export default function Dashboard() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [qrStore, setQrStore] = useState<StoreSummary | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading && !user) navigate('/login', { replace: true });
  }, [loading, user, navigate]);

  const load = () => {
    api.myStores().then((r) => setStores(r.stores)).catch((e) => setError(e.message));
  };
  useEffect(() => {
    if (user) load();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Restore a transfer bundle exported from another StoreMap instance. */
  const importFile = async (file: File) => {
    setImporting(true);
    setError('');
    try {
      const { store } = await api.importStore(file);
      navigate(`/dashboard/stores/${store.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      load();
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (loading || !user) return <main className="container"><p className="muted">Loading…</p></main>;

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>My stores</h1>
          <p className="muted" style={{ margin: 0 }}>
            Draw a top-down map, pin products, and share a public link with shoppers.
          </p>
        </div>
        <div className="page-head-actions">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
          />
          <button className="btn" disabled={importing} onClick={() => fileRef.current?.click()} title="Import a map exported from another StoreMap instance">
            {importing ? 'Importing…' : '⬆ Import map'}
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            + New store
          </button>
        </div>
      </div>

      {error && <div className="error-note">{error}</div>}
      {stores === null ? (
        <p className="muted">Loading…</p>
      ) : stores.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-art" aria-hidden>🗺️</div>
          <h3 style={{ margin: '0 0 6px' }}>No stores yet</h3>
          <p style={{ margin: '0 0 16px' }}>
            Create your first store, draw its shelves with the Aisle-pair tool, pin a few products —
            then print the QR by the door. It takes about ten minutes.
          </p>
          <button className="btn primary" onClick={() => setCreating(true)}>
            Create a store
          </button>
        </div>
      ) : (
        <div className="grid-stores">
          {stores.map((s) => (
            <StoreCard key={s.id} store={s} onChanged={load} onQR={() => setQrStore(s)} />
          ))}
        </div>
      )}

      {creating && (
        <CreateStoreModal
          onClose={() => setCreating(false)}
          onCreated={(store) => {
            setCreating(false);
            navigate(`/dashboard/stores/${store.id}`);
          }}
        />
      )}
      {qrStore && <QrModal store={qrStore} onClose={() => setQrStore(null)} />}
    </main>
  );
}

function StoreCard({ store, onChanged, onQR }: { store: StoreSummary; onChanged: () => void; onQR: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const publicUrl = `${window.location.origin}/s/${store.slug}`;

  const togglePublic = async () => {
    await api.updateStore(store.id, { is_public: !store.is_public });
    onChanged();
  };
  const remove = async () => {
    await api.deleteStore(store.id);
    setConfirming(false);
    onChanged();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const accent = ACCENTS[[...store.id].reduce((a, c) => a + c.charCodeAt(0), 0) % ACCENTS.length];
  return (
    <div className="card store-card">
      <div className="store-accent" style={{ background: `linear-gradient(120deg, ${accent}, ${accent}99)` }}>
        {store.logo_url ? (
          <img src={store.logo_url} alt="" />
        ) : (
          <span className="store-initial">{store.name[0]?.toUpperCase() ?? '?'}</span>
        )}
        <span className={`store-status ${store.is_public ? 'live' : 'draft'}`}>
          {store.is_public ? '● Live' : '○ Draft'}
        </span>
      </div>
      <div className="store-card-body">
        <div className="row-between">
          <h3>{store.name}</h3>
          <label className="toggle" title={store.is_public ? 'Visible to shoppers' : 'Hidden from shoppers'}>
            <input type="checkbox" checked={store.is_public} onChange={togglePublic} />
            <span className="track" />
          </label>
        </div>
        <span className="addr">{store.address || 'No address set'}</span>
        <div className="badges">
          <span className="badge">{store.product_count ?? 0} product{(store.product_count ?? 0) === 1 ? '' : 's'}</span>
          <span className="badge gray">{store.floor_count ?? 1} floor{(store.floor_count ?? 1) > 1 ? 's' : ''}</span>
        </div>
        <div className="public-link-row">
          <code>/s/{store.slug}</code>
          <button className="btn sm" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
          <button className="btn sm" onClick={onQR}>QR</button>
          {typeof store.views === 'number' && (
            <span className="badge gray" title="Shopper views (origin hits)">👁 {store.views}</span>
          )}
        </div>
        <StoreChecklist store={store} />
        <div className="store-actions">
          <Link className="btn primary sm" to={`/dashboard/stores/${store.id}`} style={{ flex: 1 }}>
            ✎ Edit map
          </Link>
          <Link className="btn sm" to={`/dashboard/stores/${store.id}/stock`} title="Stock tracking">📦</Link>
          <Link className="btn sm" to={`/s/${store.slug}`} target="_blank" title="Open the shopper view">↗</Link>
          <button
            className="btn sm ghost"
            title="Duplicate this store (as a draft)"
            onClick={async () => {
              setCopying(true);
              try {
                await api.duplicateStore(store.id);
                onChanged();
              } finally {
                setCopying(false);
              }
            }}
          >
            {copying ? '…' : '⧉'}
          </button>
          <button
            className="btn sm ghost"
            title="Export a transfer file (map, catalog, images) — import it on another StoreMap instance"
            onClick={() => api.exportStore(store.id, store.slug).catch((e) => window.alert(e instanceof Error ? e.message : 'Export failed'))}
          >
            ⬇
          </button>
          <button className="btn sm ghost" onClick={() => setConfirming(true)} title="Delete this store">🗑</button>
        </div>
      </div>
      {confirming && (
        <Modal title={`Delete “${store.name}”?`} onClose={() => setConfirming(false)}>
          <p className="muted">This permanently removes the store, its maps, products and pins.</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn danger" onClick={remove}>Delete store</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateStoreModal({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (s: StoreSummary) => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { store } = await api.createStore({ name, address });
      onCreated(store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create store');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create a store" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Store name">
          <input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Freshmart Downtown" />
        </Field>
        <Field label="Address (optional)">
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 High St, Springfield" />
        </Field>
        {error && <div className="error-note">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create & open editor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** D2: store health checklist — tells owners what "done" looks like. */
function StoreChecklist({ store }: { store: StoreSummary }) {
  const prods = store.product_count ?? 0;
  const items: [string, boolean][] = [
    ['Map drawn', (store.floor_count ?? 0) >= 1],
    ['Entrance placed', true],
    ['Products pinned', prods >= 10],
    ['Published', store.is_public],
  ];
  const done = items.filter(([, ok]) => ok).length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <div className="checklist">
      <div className="check-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="check-items">
        {items.map(([label, ok]) => (
          <span key={label} className={ok ? 'ok' : 'todo'}>
            {ok ? '✓' : '○'} {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function QrModal({ store, onClose }: { store: StoreSummary; onClose: () => void }) {
  const [src, setSrc] = useState('');
  // server-canonical url — QR codes can't be hijacked by an embedding host
  const url = store.shareUrl || `${window.location.origin}/s/${store.slug}`;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // H3: high error correction leaves the center scannable with a logo punch-out
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
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <Modal title={`Shopper QR — ${store.name}`} onClose={onClose}>
      <div className="qr-box">
        {src ? <img src={src} alt="QR code" /> : <p className="muted">Generating…</p>}
        <code style={{ fontSize: 12.5, wordBreak: 'break-all', textAlign: 'center' }}>{url}</code>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Print this by the entrance — shoppers scan and instantly see your map.
        </p>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
