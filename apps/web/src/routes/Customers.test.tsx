import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveContact, createContact, listContacts, listInvoices, updateContact } from '../lib/api.ts';
import Customers from './Customers.tsx';

vi.mock('../lib/api.ts', () => ({
  listContacts: vi.fn(),
  listInvoices: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  archiveContact: vi.fn(),
}));

function mkCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    displayName: 'Acme Co',
    email: 'billing@acme.test',
    phone: '555-0100',
    isCustomer: true,
    isVendor: false,
    isEmployee: false,
    isActive: true,
    syncState: 'synced' as const,
    qboUrl: null,
    ...overrides,
  };
}

describe('Customers', () => {
  beforeEach(() => {
    vi.mocked(listContacts).mockReset();
    vi.mocked(listInvoices).mockReset();
    vi.mocked(createContact).mockReset();
    vi.mocked(updateContact).mockReset();
    vi.mocked(archiveContact).mockReset();
    vi.mocked(listInvoices).mockResolvedValue([]);
  });

  it('clicking Edit opens the drawer prefilled with the customer values', async () => {
    vi.mocked(listContacts).mockResolvedValue([mkCustomer()]);

    render(<Customers />);

    const editButton = await screen.findByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Acme Co');
    expect(screen.getByLabelText('Email')).toHaveValue('billing@acme.test');
    expect(screen.getByLabelText('Phone')).toHaveValue('555-0100');
  });

  it('submitting the edit form calls updateContact with the edited values and reloads the list', async () => {
    vi.mocked(listContacts).mockResolvedValue([mkCustomer()]);
    vi.mocked(updateContact).mockResolvedValue(mkCustomer({ displayName: 'Acme Corp' }));

    render(<Customers />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('cust-1', {
        displayName: 'Acme Corp',
        email: 'billing@acme.test',
        phone: '555-0100',
      }),
    );
    expect(createContact).not.toHaveBeenCalled();
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(2));
  });

  it('cancelling the edit drawer does not call updateContact', async () => {
    vi.mocked(listContacts).mockResolvedValue([mkCustomer()]);

    render(<Customers />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateContact).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Add customer" still opens a blank drawer and still calls createContact', async () => {
    vi.mocked(listContacts).mockResolvedValue([mkCustomer()]);
    vi.mocked(createContact).mockResolvedValue(mkCustomer({ id: 'cust-2', displayName: 'New Co' }));

    render(<Customers />);

    await screen.findByText('Acme Co');
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));

    expect(screen.getByRole('dialog', { name: 'Add customer' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Co' } });
    const addButtons = screen.getAllByRole('button', { name: 'Add customer' });
    fireEvent.click(addButtons[addButtons.length - 1]);

    await waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({
        displayName: 'New Co',
        email: undefined,
        phone: undefined,
        isCustomer: true,
      }),
    );
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('shows an inline error and keeps the drawer open when updateContact rejects', async () => {
    vi.mocked(listContacts).mockResolvedValue([mkCustomer()]);
    vi.mocked(updateContact).mockRejectedValue(new Error('boom'));

    render(<Customers />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not update the customer.',
    );
  });
});
