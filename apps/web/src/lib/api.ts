// Typed fetch client for /api/*. Same-origin, httpOnly cookie auth: every
// call sends `credentials: 'include'` and the frontend never reads or sets
// the session cookie itself (see rules/payments-adjacent architecture-decisions.md
// "Frontend deployment" - no CORS, no token in JS).

export interface CurrentUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; leave `body` as null.
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function login(email: string, password: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function me(): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/me');
}
