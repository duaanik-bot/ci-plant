import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { lazy, Suspense, useEffect } from 'react';
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
const FinishedGoods = lazy(() => import('./pages/FinishedGoods.jsx'));
const Logbook = lazy(() => import('./pages/Logbook.jsx'));
const ExtraSheets = lazy(() => import('./pages/ExtraSheets.jsx'));
const CuttingVariances = lazy(() => import('./pages/CuttingVariances.jsx'));
const StockWriteOns = lazy(() => import('./pages/StockWriteOns.jsx'));
const JobCardPrint = lazy(() => import('./pages/JobCardPrint.jsx'));
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

export default function App() {
  return (
    <ToastProvider>
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
                {/* QC inspection is consolidated into the Finished Goods & QC module */}
                <Route path="/floor/qc" element={<Navigate to="/finished-goods" replace />} />
                <Route path="/floor/:section" element={<Section />} />
                <Route path="/track" element={<Track />} />
                <Route path="/status-sheet" element={<StatusSheet />} />
                <Route path="/finished-goods" element={<FinishedGoods />} />
                <Route path="/extra-sheets" element={<ExtraSheets />} />
                <Route path="/cutting-variances" element={<CuttingVariances />} />
                <Route path="/stock-writeons" element={<StockWriteOns />} />
                <Route path="/logbook" element={<Logbook />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/planning" element={<Planning />} />
                <Route path="/artwork" element={<Artwork />} />
                <Route path="/production" element={<Production />} />
                <Route path="/production/jobcard/:id" element={<JobCardPrint />} />
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
                <Route path="/tooling" element={<Tooling />} />
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
