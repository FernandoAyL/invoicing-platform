import { useState } from 'react';
import { Link, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { logout } from './lib/api.ts';
import { RequireAuth } from './lib/RequireAuth.tsx';
import Customers from './routes/Customers.tsx';
import Dashboard from './routes/Dashboard.tsx';
import Home from './routes/Home.tsx';
import InvoiceDetail from './routes/InvoiceDetail.tsx';
import InvoiceEdit from './routes/InvoiceEdit.tsx';
import InvoiceNew from './routes/InvoiceNew.tsx';
import Invoices from './routes/Invoices.tsx';
import Login from './routes/Login.tsx';
import Pricing from './routes/Pricing.tsx';
import Products from './routes/Products.tsx';

function Layout() {
  return (
    <div>
      <header>
        <nav>
          <Link to="/">Invoicing Platform</Link> <Link to="/products">Products</Link>{' '}
          <Link to="/pricing">Pricing</Link> <Link to="/login">Sign in</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function AuthedLayout() {
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      // Land on /login regardless of whether the request itself succeeded -
      // the client session view is cleared either way.
      navigate('/login', { replace: true });
    }
  }

  return (
    <div>
      <header>
        <nav>
          <Link to="/dashboard">Dashboard</Link> <Link to="/invoices">Invoices</Link>{' '}
          <Link to="/customers">Customers</Link>{' '}
          <button type="button" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out...' : 'Log out'}
          </button>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/products" element={<Products />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/login" element={<Login />} />
      </Route>
      <Route element={<AuthedLayout />}>
        <Route
          path="/dashboard"
          element={<RequireAuth>{(user) => <Dashboard user={user} />}</RequireAuth>}
        />
        <Route path="/invoices" element={<RequireAuth>{() => <Invoices />}</RequireAuth>} />
        <Route path="/invoices/new" element={<RequireAuth>{() => <InvoiceNew />}</RequireAuth>} />
        <Route
          path="/invoices/:id"
          element={<RequireAuth>{() => <InvoiceDetail />}</RequireAuth>}
        />
        <Route
          path="/invoices/:id/edit"
          element={<RequireAuth>{() => <InvoiceEdit />}</RequireAuth>}
        />
        <Route path="/customers" element={<RequireAuth>{() => <Customers />}</RequireAuth>} />
      </Route>
    </Routes>
  );
}
