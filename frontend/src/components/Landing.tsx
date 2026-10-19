import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Map3D from './Map3D';
import type { MapElement, PublicStorePayload, StoreSummary } from '../types';
import { parseElement } from '../types';
import type { Camera3D } from '../lib/render3d';
import { fitCamera, MODERN_THEME, DARK_THEME } from '../lib/render3d';
import { useTheme } from '../theme';

/** The landing hero shows the real demo store turning in 3D — the product IS the demo. */
function HeroMap() {
  const [data, setData] = useState<PublicStorePayload | null>(null);
  const [cam, setCam] = useState<Camera3D | null>(null);
  const raf = useRef<number>(0);

  useEffect(() => {
    let live = true;
    api
      .publicStore('freshmart-downtown')
      .then((d) => live && setData(d))
      .catch(() => { /* demo not seeded — hero falls back to the plain gradient */ });
    return () => {
      live = false;
    };
  }, []);

  const floor = data?.floors[0] ?? null;
  const { resolved } = useTheme();
  const sceneTheme = resolved === 'dark' ? DARK_THEME : MODERN_THEME;
  const elements = useMemo(() => (data ? data.elements.map(parseElement) : []), [data]);
  const pins = useMemo(() => {
    if (!data || !floor) return [];
    return data.locations
      .filter((l) => l.floor_id === floor.id)
      .map((location) => ({ location, product: data.products.find((p) => p.id === location.product_id)! }))
      .filter((p) => p.product)
      .slice(0, 60); // keep the hero light
  }, [data, floor]);

  // slow auto-orbit; stop when the tab is hidden
  useEffect(() => {
    if (!data) return;
    if (cam === null) setCam(fitCamera(floor!));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // keep it still
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (!document.hidden) {
        setCam((c) => (c ? { ...c, yaw: c.yaw + dt * 0.00012 } : c));
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [data, cam === null, floor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !floor || !cam) return null;
  return (
    <div className="hero-map" aria-hidden>
      {/* pointer-events: none via CSS — the hero is a living picture, scrolling stays natural */}
      <Map3D
        floor={floor}
        elements={elements.filter((e: MapElement) => e.floor_id === floor.id)}
        pins={pins}
        camera={cam}
        onCamera={() => {}}
        theme={sceneTheme}
      />
    </div>
  );
}

export default function Landing() {
  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    api.publicStores(q).then((r) => live && setStores(r.stores)).catch(() => live && setStores([]));
    return () => {
      live = false;
    };
  }, [q]);

  return (
    <main className="container">
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Never wander the aisles again. <em>Find it on the map.</em>
          </h1>
          <p>
            StoreMap gives every store an interactive 3D map. Shoppers search a product and watch the
            camera fly the route from the entrance straight to the shelf — on any device, no app required.
          </p>
          <div className="hero-actions">
            <Link to="/dashboard" className="btn primary">
              I own a store — create my map
            </Link>
            <Link to="/s/freshmart-downtown" className="btn">
              ▶ See the live demo
            </Link>
            <Link to="/self-host" className="btn">
              🖥 Host your own
            </Link>
          </div>
        </div>
        <div className="hero-visual">
          <HeroMap />
        </div>
      </section>

      <section className="steps">
        <div className="card step">
          <span className="num">1</span>
          <h4>Draw your store</h4>
          <p>Trace walls, shelves and aisles in a friendly top-down editor — the Aisle pair tool stamps facing rows in one drag.</p>
        </div>
        <div className="card step">
          <span className="num">2</span>
          <h4>Drop product pins</h4>
          <p>Add products and place them on their shelf. Categories keep everything organized and color-coded.</p>
        </div>
        <div className="card step">
          <span className="num">3</span>
          <h4>Share one link</h4>
          <p>Print the QR code by the entrance. Shoppers search, see the route, and fly to the item in seconds.</p>
        </div>
      </section>

      <section id="directory">
        <div className="page-head" style={{ marginTop: 40 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Find a store
          </h2>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Search by name, address…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {stores === null ? (
          <p className="muted">Loading…</p>
        ) : stores.length === 0 ? (
          <div className="empty-state card">
            <p>No public stores yet. Own a shop? Be the first — create your map in minutes.</p>
          </div>
        ) : (
          <div className="grid-stores">
            {stores.map((s) => (
              <Link key={s.id} to={`/s/${s.slug}`} className="card store-card" style={{ color: 'inherit' }}>
                <h3>{s.name}</h3>
                <span className="addr">{s.address || '—'}</span>
                <div className="badges">
                  <span className="badge">{s.product_count ?? 0} product{(s.product_count ?? 0) === 1 ? "" : "s"}</span>
                  <span className="badge gray">{s.floor_count ?? 1} floor{(s.floor_count ?? 1) > 1 ? 's' : ''}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <footer className="footer">
        StoreMap — in-store navigation for humans. · <Link to="/self-host">Self-host your own</Link>
      </footer>
    </main>
  );
}
