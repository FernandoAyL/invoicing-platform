import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Home from './Home.tsx';

describe('Home', () => {
  it('renders its heading with no network calls', () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /invoicing platform/i })).toBeInTheDocument();
  });
});
