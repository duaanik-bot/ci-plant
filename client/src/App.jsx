import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { startBuildWatch } from './lib/buildWatch.js';
import { lazy, Suspense, useEffect, useState } from 'react';
import { canAccess, canAccessSection, moduleForPath, firstAllowedPath } from './modules.js';
import AppLayout from './components/AppLayout.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';
import { setErrorHandler, setUnauthorizedHandler, auth } from './api.js';
// Login stays eager — it is the first paint for a signed-out user. Every other
// page is a lazy route chunk so the shell loads without the whole app's code.
import Login from './pages/Login.jsx';
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const Planning = lazy(() => import('./pages/Planning.jsx'));
const Artwork = lazy(() => import('./pages/Artwork.jsx'));
const Production = lazy(() => import('./pages/Production.jsx'));
const Inventory = lazy(() => import('./pages/Inventory.jsx'));
const Procurement = lazy(() => import('./pages/Procurement.jsx'));
const DispatchInvoice = lazy(() => import('./pages/DispatchInvoice.jsx'));
const Challan = lazy(() => import('./pages/Challan.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Masters = lazy(() => import('./pages/Masters.jsx'));
const Floor = lazy(() => import('./pages/Floor.jsx'));
const Section = lazy(() => import('./pages/Section.jsx'));
const SortPaste = lazy(() => import('./pages/SortPaste.jsx'));
const Track = lazy(() => import('./pages/Track.jsx'));
const StatusSheet = lazy(() => import('./pages/StatusSheet.jsx'));
const Invoice = lazy(() => import('./pages/Invoice.jsx'));
const Accounts = lazy(() => import('./pages/Accounts.jsx'));
const PrintPlanning = lazy(() => import('./pages/PrintPlanning.jsx'));
const PressLineup = lazy(() => import('./pages/PressLineup.jsx'));
const Logbook = lazy(() => import('./pages/Logbook.jsx'));
const ExtraSheets = lazy(() => import('./pages/ExtraSheets.jsx'));
const CuttingVariances = lazy(() => import('./pages/CuttingVariances.jsx'));
const StageDiscrepancies = lazy(() => import('./pages/StageDiscrepancies.jsx'));
const StockWriteOns = lazy(() => import('./pages/StockWriteOns.jsx'));
const JobCardPrint = lazy(() => import('./pages/JobCardPrint.jsx'));
const JobCardBatchPrint = lazy(() => import('./pages/JobCardBatchPrint.jsx'));
const BoardStockVerification = lazy(() => import('./pages/BoardStockVerification.jsx'));
const Tooling = lazy(() => import('./pages/Tooling.jsx'));
const ShadeCards = lazy(() => import('./pages/ShadeCards.jsx'));
const POPrint = lazy(() => import('./pages/POPrint.jsx'));
const COA = lazy(() => import('./pages/COA.jsx'));

// Quiet placeholder while a route chunk downloads — matches the app's muted grey.
function PageLoading() {
  return <div className="p-8 text-sm text-slate-400">Loading…</div>;
}

function Bridges({ children }) {
  const toast = useToast();
  const nav = useNavigate();
  useEffect(() => {
    setErrorHandler(msg => toast.error(msg));
    setUnauthorizedHandler(() => nav('/login', { replace: true }));
  }, [toast, nav]);
  return children;
}

function RequireAuth() {
  const location = useLocation();
  if (!auth.token) return <Navigate to="/login" replace />;
  // Per-user module gate: a restricted account that types a URL for a module
  // it wasn't given lands on its first allowed module instead.
  const mod = moduleForPath(location.pathname);
  if (mod && !canAccess(auth.user, mod)) return <Navigate to={firstAllowedPath(auth.user)} replace />;
  // Live-Floor station gate: a station-scoped operator who types a URL for a
  // section they weren't dedicated to lands on their own board instead. The
  // combined Sort & Paste station needs either sorting or pasting.
  if (location.pathname === '/floor/sort-paste') {
    if (!canAccessSection(auth.user, 'sorting') && !canAccessSection(auth.user, 'pasting'))
      return <Navigate to={firstAllowedPath(auth.user)} replace />;
  } else {
    const sec = location.pathname.match(/^\/floor\/([^/]+)$/);
    if (sec && !canAccessSection(auth.user, sec[1])) return <Navigate to={firstAllowedPath(auth.user)} replace />;
  }
  return <Outlet />;
}

// The way out, on a device that has no other one.
//
// A plant tablet runs as an installed PWA: no address bar, no reload button, no
// pull-to-refresh. When a deploy pulled its files away it rendered Live Floor
// with real figures and no stylesheet, said nothing about why, and could only be
// recovered by closing the app from the recents switcher — which no one on a
// floor knows to do. One Printing tablet sat like that for five hours.
//
// buildWatch reloads by itself while the page is HIDDEN, so most deploys are
// picked up with nobody watching and this bar is never seen. It appears only
// when the screen is in front of someone, because that is exactly when reloading
// out from under them would be the wrong thing to do.
function UpdateBar() {
  const [ready, setReady] = useState(false);
  useEffect(() => startBuildWatch({ onNewBuild: () => setReady(true) }), []);
  if (!ready) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-[300] flex items-center justify-between gap-3 bg-[#B45309] px-4 pb-2 text-white shadow-lift"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      role="status"
    >
      <span className="text-xs font-bold tracking-[-0.01em]">
        A newer version of the app is ready.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-[#B45309]"
      >
        Reload
      </button>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <UpdateBar />
      <BrowserRouter>
        <Bridges>
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth />}>
              <Route element={<AppLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="/floor" element={<Floor />} />
                <Route path="/floor/sort-paste" element={<SortPaste />} />
                {/* Sorting & Pasting are merged — old links land on the combined station */}
                <Route path="/floor/sorting" element={<Navigate to="/floor/sort-paste" replace />} />
                <Route path="/floor/pasting" element={<Navigate to="/floor/sort-paste" replace />} />
                {/* Finished Goods & QC is gone — Sort & Paste releases straight to
                    Dispatch. Old links and pinned logins land there. */}
                <Route path="/floor/qc" element={<Navigate to="/dispatch-invoice" replace />} />
                <Route path="/floor/:section" element={<Section />} />
                <Route path="/track" element={<Track />} />
                <Route path="/status-sheet" element={<StatusSheet />} />
                <Route path="/finished-goods" element={<Navigate to="/dispatch-invoice?tab=fg" replace />} />
                <Route path="/extra-sheets" element={<ExtraSheets />} />
                <Route path="/cutting-variances" element={<CuttingVariances />} />
                <Route path="/stage-discrepancies" element={<StageDiscrepancies />} />
                <Route path="/stock-writeons" element={<StockWriteOns />} />
                <Route path="/logbook" element={<Logbook />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/planning" element={<Planning />} />
                <Route path="/artwork" element={<Artwork />} />
                <Route path="/production" element={<Production />} />
                <Route path="/production/jobcard/:id" element={<JobCardPrint />} />
                {/* Plural — the batch stack. Distinct segment from the singular
                    /jobcard/:id above, so ':id' can never swallow it. */}
                <Route path="/production/jobcards/print" element={<JobCardBatchPrint />} />
                <Route path="/production/board-stock-verification" element={<BoardStockVerification />} />
                <Route path="/print-planning" element={<PrintPlanning />} />
                <Route path="/print-planning/lineup" element={<PressLineup />} />
                <Route path="/procurement/po/:id" element={<POPrint />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/procurement" element={<Procurement />} />
                {/* Dispatch + Invoices consolidated into one module */}
                <Route path="/dispatch-invoice" element={<DispatchInvoice />} />
                <Route path="/dispatch" element={<Navigate to="/dispatch-invoice" replace />} />
                <Route path="/dispatch/challan/:id" element={<Challan />} />
                <Route path="/invoices" element={<Navigate to="/dispatch-invoice?tab=invoices" replace />} />
                <Route path="/invoices/:id" element={<Invoice />} />
                <Route path="/coas/:id" element={<COA />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/masters" element={<Masters />} />
                <Route path="/tooling" element={<Navigate to="/tooling/plates" replace />} />
                <Route path="/tooling/plates" element={<Tooling family="plate" />} />
                <Route path="/tooling/dies" element={<Tooling family="die" />} />
                <Route path="/tooling/blocks" element={<Tooling family="block" />} />
                <Route path="/tooling/shade-cards" element={<Tooling family="shade_card" />} />
                <Route path="/tooling/:family/po/:id" element={<POPrint />} />
                <Route path="/shade-cards" element={<ShadeCards />} />
              </Route>
            </Route>
          </Routes>
          </Suspense>
        </Bridges>
      </BrowserRouter>
    </ToastProvider>
  );
}
