import { useCallback, useEffect, useState } from 'react';
import { ApiError, type CurrentUser, me as fetchMe } from './api.ts';

export type SessionState =
  | { status: 'loading'; user: null }
  | { status: 'authenticated'; user: CurrentUser }
  | { status: 'unauthenticated'; user: null };

export type UseSessionResult = SessionState & { refresh: () => void };

// Fetches the current session from /api/auth/me. Only used on auth routes
// (Login, RequireAuth) - public marketing routes never mount this, so they
// stay network-free and crawlable.
export function useSession(): UseSessionResult {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null });

  const refresh = useCallback(() => {
    let cancelled = false;
    setState({ status: 'loading', user: null });

    fetchMe()
      .then((user) => {
        if (!cancelled) setState({ status: 'authenticated', user });
      })
      .catch(() => {
        // Any failure (401, network error) is treated as "not signed in" -
        // the guard doesn't distinguish reasons, it just sends you to /login.
        if (!cancelled) setState({ status: 'unauthenticated', user: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  return { ...state, refresh };
}

export { ApiError };
