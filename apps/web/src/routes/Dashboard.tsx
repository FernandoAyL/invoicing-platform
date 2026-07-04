import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CurrentUser } from '../lib/api.ts';
import { logout } from '../lib/api.ts';

export interface DashboardProps {
  user: CurrentUser;
}

export default function Dashboard({ user }: DashboardProps) {
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
    <section>
      <h1>Dashboard</h1>
      <p>
        Welcome, {user.email} ({user.role})
      </p>
      <button type="button" onClick={handleLogout} disabled={loggingOut}>
        {loggingOut ? 'Signing out...' : 'Log out'}
      </button>
    </section>
  );
}
