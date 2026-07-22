import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useEffect } from 'react';
import { canAccess, canAccessSection, moduleForPath, firstAllowedPath } from './modules.js';
import AppLayout from './components/AppLayout.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';
import { setErrorHandler, setUnauthorizedHandler, auth } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Orders from './pages/Orders.jsx';
import Planning from './pages/Planning.jsx';
import Artwork from './pages/Artwork.jsx';
import Production from './pages/Production.jsx';
import Inventory from './pages/Inventory.jsx';
import Procurement from './pages/Procurement.jsx';
import Dispatch from './pages/Dispatch.jsx';
import DispatchInvoice from './pages/DispatchInvoice.jsx';
import Challan from './pages/Challan.jsx';
import Reports from './pages/Reports.jsx';
import Masters from './pages/Masters.jsx';
import Floor from './pages/Floor.jsx';
import Section from './pages/Section.jsx';
import SortPaste from './pages/SortPaste.jsx';
import Track from './pages/Track.jsx';
import StatusSheet from './pages/StatusSheet.jsx';
import Invoices from './pages/Invoices.jsx';
import Invoice from './pages/Invoice.jsx';
import Accounts from './pages/Accounts.jsx';
import PrintPlanning from './pages/PrintPlanning.jsx';
import FinishedGoods from './pages/FinishedGoods.jsx';
import Logbook from './pages/Logbook.jsx';
import ExtraSheets from './pages/ExtraSheets.jsx';
import CuttingVariances from './pages/CuttingVariances.jsx';
import JobCardPrint from './pages/JobCardPrint.jsx';
import Tooling from './pages/Tooling.jsx';
import ShadeCards from './pages/ShadeCards.jsx';
import POPrint from './pages/POPrint.jsx';
import COA from './pages/COA.jsx';

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
                <Route path="/logbook" element={<Logbook />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/planning" element={<Planning />} />
                <Route path="/artwork" element={<Artwork />} />
                <Route path="/production" element={<Production />} />
                <Route path="/production/jobcard/:id" element={<JobCardPrint />} />
                <Route path="/print-planning" element={<PrintPlanning />} />
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
        </Bridges>
      </BrowserRouter>
    </ToastProvider>
  );
}
