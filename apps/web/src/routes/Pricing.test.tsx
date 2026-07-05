import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Pricing from './Pricing.tsx';

describe('Pricing', () => {
  it('renders its heading', () => {
    render(
      <MemoryRouter>
        <Pricing />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /pricing/i })).toBeInTheDocument();
  });
});
