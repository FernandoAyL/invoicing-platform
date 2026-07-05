import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Pricing from './Pricing.tsx';

describe('Pricing', () => {
  it('renders its heading', () => {
    render(<Pricing />);
    expect(screen.getByRole('heading', { name: /pricing/i })).toBeInTheDocument();
  });
});
