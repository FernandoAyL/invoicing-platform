import { Route, Routes, useOutletContext } from 'react-router-dom';
import { PublicLayout } from './components/marketing/PublicLayout.tsx';
import { AppShell } from './components/shell/AppShell.tsx';
import type { CurrentUser } from './lib/api.ts';
import { RequireAuth } from './lib/RequireAuth.tsx';
import Conflicts from './routes/Conflicts.tsx';
import Customers from './routes/Customers.tsx';
import Dashboard from './routes/Dashboard.tsx';
import Home from './routes/Home.tsx';
import Integrations from './routes/Integrations.tsx';
import InvoiceDetail from './routes/InvoiceDetail.tsx';
import InvoiceEdit from './routes/InvoiceEdit.tsx';
import InvoiceNew from './routes/InvoiceNew.tsx';
import Invoices from './routes/Invoices.tsx';
import Login from './routes/Login.tsx';
import Pricing from './routes/Pricing.tsx';
import Products from './routes/Products.tsx';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/products" element={<Products />} />
        <Route path="/pricing" element={<Pricing />} />
      </Route>
      {/* Login is standalone (centered branded auth card) - no marketing chrome. */}
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth>{(user) => <AppShell user={user} />}</RequireAuth>}>
        <Route path="/dashboard" element={<DashboardRoute />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/invoices/new" element={<InvoiceNew />} />
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
        <Route path="/invoices/:id/edit" element={<InvoiceEdit />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/conflicts" element={<Conflicts />} />
      </Route>
    </Routes>
  );
}

// Dashboard is the one screen that still needs the resolved `user` (for the
// greeting). RequireAuth now guards the whole shell once (a single
// /api/auth/me call for every authed route, and the sidebar/topbar no
// longer render before auth resolves); AppShell forwards that user via
// Outlet context instead of each leaf route re-fetching its own session.
function DashboardRoute() {
  const user = useOutletContext<CurrentUser>();
  return <Dashboard user={user} />;
}
