import { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import type { AuthInfo } from './types';
import { ThemeProvider } from './theme';
import Landing from './components/Landing';
import Login from './components/Login';
import SelfHost from './components/SelfHost';
import Dashboard from './components/Dashboard';
import EditorPage from './components/EditorPage';
import StockPage from './components/StockPage';
import ViewerPage from './components/ViewerPage';
import ThemeSettings from './components/ThemeSettings';

interface AuthCtx extends AuthInfo {
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx>({ user: null, providers: { google: false, apple: false, dev: false }, loading: true, refresh: async () => {} });
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [auth, setAuth] = useState<AuthInfo>({ user: null, providers: { google: false, apple: false, dev: false } });
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  // the shopper viewer is a full-bleed experience — no site chrome
  const isViewer = location.pathname.startsWith('/s/');

  const refresh = async () => {
    try {
      setAuth(await api.me());
    } catch {
      /* offline / server restarting */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <AuthContext.Provider value={{ ...auth, loading, refresh }}>
      <ThemeProvider>
        <div className="app-shell">
          {!isViewer && <TopNav />}
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/self-host" element={<SelfHost />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboard/stores/:storeId" element={<EditorPage />} />
            <Route path="/dashboard/stores/:storeId/stock" element={<StockPage />} />
            <Route path="/s/:slug" element={<ViewerPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </ThemeProvider>
    </AuthContext.Provider>
  );
}

function TopNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const logout = async () => {
    await api.logout();
    navigate('/');
  };
  return (
    <nav className="topnav">
      <Link to="/" className="brand">
        <span className="brand-logo">▦</span> StoreMap
      </Link>
      <div className="spacer" />
      <ThemeSettings />
      {user ? (
        <div className="nav-user">
          <NavLink to="/dashboard" className="btn ghost sm">
            My stores
          </NavLink>
          <span className="avatar" title={user.email}>
            {(user.name || user.email)[0]?.toUpperCase()}
          </span>
          <button className="btn ghost sm" onClick={logout}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="nav-user">
          <Link to="/login" className="btn sm">
            Store owner sign in
          </Link>
        </div>
      )}
    </nav>
  );
}

function NotFound() {
  return (
    <div className="container">
      <div className="empty-state card">
        <div className="empty-art" aria-hidden>🧭</div>
        <h2 style={{ margin: '0 0 6px' }}>You're off the map</h2>
        <p style={{ margin: '0 0 16px' }}>The page you're after doesn't exist — but every store is one tap away.</p>
        <div className="hero-actions" style={{ justifyContent: 'center' }}>
          <Link to="/" className="btn primary">Browse stores</Link>
          <Link to="/s/freshmart-downtown" className="btn">See the demo</Link>
        </div>
      </div>
    </div>
  );
}
