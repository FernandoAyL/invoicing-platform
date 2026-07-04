import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { login, me } from '../lib/api.ts';
import Login from './Login.tsx';

vi.mock('../lib/api.ts', () => ({
  login: vi.fn(),
  me: vi.fn(),
}));

describe('Login', () => {
  beforeEach(() => {
    vi.mocked(me).mockReset().mockRejectedValue(new Error('not signed in'));
    vi.mocked(login).mockReset();
  });

  it('renders the sign-in form and checks for an existing session', async () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    await waitFor(() => expect(me).toHaveBeenCalledTimes(1));
  });

  it('surfaces a generic error on invalid credentials, without redirecting', async () => {
    vi.mocked(login).mockRejectedValue(new Error('invalid_credentials'));
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/email/i), 'admin@invoicing.test');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
});
