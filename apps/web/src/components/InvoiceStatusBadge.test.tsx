import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InvoiceStatus } from '../lib/api.ts';
import { InvoiceStatusBadge } from './InvoiceStatusBadge.tsx';

const CASES: Array<{ status: InvoiceStatus; label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'partially_paid', label: 'Partially paid' },
  { status: 'paid', label: 'Paid' },
  { status: 'void', label: 'Void' },
];

describe('InvoiceStatusBadge', () => {
  it.each(CASES)('renders the $status status with its label', ({ status, label }) => {
    render(<InvoiceStatusBadge status={status} />);
    const badge = screen.getByTestId('invoice-status-badge');
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveAttribute('data-status', status);
  });

  it('renders visually distinct states (different background colors)', () => {
    const colors = CASES.map(({ status }) => {
      const { unmount } = render(<InvoiceStatusBadge status={status} />);
      const color = screen.getByTestId('invoice-status-badge').style.backgroundColor;
      unmount();
      return color;
    });
    expect(new Set(colors).size).toBe(CASES.length);
  });
});
