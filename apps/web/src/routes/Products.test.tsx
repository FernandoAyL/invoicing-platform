import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Products from './Products.tsx';

describe('Products', () => {
  it('renders its heading', () => {
    render(<Products />);
    expect(screen.getByRole('heading', { name: /products/i })).toBeInTheDocument();
  });
});
