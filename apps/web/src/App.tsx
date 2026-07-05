import { Link, Outlet, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './lib/RequireAuth.tsx';
import Dashboard from './routes/Dashboard.tsx';
import Home from './routes/Home.tsx';
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

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/products" element={<Products />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/dashboard"
          element={<RequireAuth>{(user) => <Dashboard user={user} />}</RequireAuth>}
        />
        <Route path="/invoices" element={<RequireAuth>{() => <Invoices />}</RequireAuth>} />
      </Route>
    </Routes>
  );
}
