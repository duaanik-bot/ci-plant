import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import AppLayout from './components/AppLayout.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';
import { setErrorHandler } from './api.js';
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

function ErrorBridge({ children }) {
  const toast = useToast();
  useEffect(() => { setErrorHandler(msg => toast.error(msg)); }, [toast]);
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <ErrorBridge>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/planning" element={<Planning />} />
              <Route path="/artwork" element={<Artwork />} />
              <Route path="/production" element={<Production />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/procurement" element={<Procurement />} />
              <Route path="/dispatch" element={<Dispatch />} />
              <Route path="/dispatch/challan/:id" element={<Challan />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/masters" element={<Masters />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ErrorBridge>
    </ToastProvider>
  );
}
