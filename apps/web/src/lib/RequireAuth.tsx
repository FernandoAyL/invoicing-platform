import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { CurrentUser } from './api.ts';
import { useSession } from './session.ts';

export interface RequireAuthProps {
  children: (user: CurrentUser) => ReactNode;
}

// Auth-route guard. Renders a loader while the session check is in flight,
// redirects to /login on any failure (401 or otherwise), and hands the
// resolved user down to `children` once authenticated - so pages like
// Dashboard don't need a second /api/auth/me fetch of their own.
export function RequireAuth({ children }: RequireAuthProps) {
  const { status, user } = useSession();

  if (status === 'loading') {
    return <p role="status">Loading...</p>;
  }

  if (status === 'unauthenticated' || !user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children(user)}</>;
}
