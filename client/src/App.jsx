import { BrowserRouter, Routes, Route, Navigate, useNavigate, Outlet } from 'react-router-dom';
import { useEffect } from 'react';
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
import Challan from './pages/Challan.jsx';
import Reports from './pages/Reports.jsx';
import Masters from './pages/Masters.jsx';
import Floor from './pages/Floor.jsx';
import Section from './pages/Section.jsx';
import Track from './pages/Track.jsx';
import Invoices from './pages/Invoices.jsx';
import Invoice from './pages/Invoice.jsx';
import Accounts from './pages/Accounts.jsx';

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
  if (!auth.token) return <Navigate to="/login" replace />;
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
                <Route path="/floor/:section" element={<Section />} />
                <Route path="/track" element={<Track />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/planning" element={<Planning />} />
                <Route path="/artwork" element={<Artwork />} />
                <Route path="/production" element={<Production />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/procurement" element={<Procurement />} />
                <Route path="/dispatch" element={<Dispatch />} />
                <Route path="/dispatch/challan/:id" element={<Challan />} />
                <Route path="/invoices" element={<Invoices />} />
                <Route path="/invoices/:id" element={<Invoice />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/masters" element={<Masters />} />
              </Route>
            </Route>
          </Routes>
        </Bridges>
      </BrowserRouter>
    </ToastProvider>
  );
}
