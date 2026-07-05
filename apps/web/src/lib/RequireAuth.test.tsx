import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { me } from './api.ts';
import { RequireAuth } from './RequireAuth.tsx';

vi.mock('./api.ts', () => ({
  me: vi.fn(),
}));

function renderAtDashboard() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route
          path="/dashboard"
          element={<RequireAuth>{(user) => <div>Secret for {user.email}</div>}</RequireAuth>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.mocked(me).mockReset();
  });

  it('redirects to /login when the session check 401s', async () => {
    vi.mocked(me).mockRejectedValue(new Error('unauthorized'));

    renderAtDashboard();

    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText(/Secret for/)).not.toBeInTheDocument();
  });

  it('renders the protected content once the session resolves', async () => {
    vi.mocked(me).mockResolvedValue({ id: '1', email: 'admin@invoicing.test', role: 'admin' });

    renderAtDashboard();

    expect(await screen.findByText('Secret for admin@invoicing.test')).toBeInTheDocument();
  });
});
