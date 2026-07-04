import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  emptyLineDraft,
  InvoiceLinesEditor,
  type LineDraft,
  parseLineDrafts,
} from '../components/InvoiceLinesEditor.tsx';
import type { Contact } from '../lib/api.ts';
import { ApiError, createContact, createInvoice, listContacts } from '../lib/api.ts';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function InvoiceNew() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [contactId, setContactId] = useState('');
  const [txnDate, setTxnDate] = useState(todayIso);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLineDraft()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [newCustomerName, setNewCustomerName] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const loadCustomers = useCallback(() => {
    return listContacts({ role: 'customer' }).then((result) => {
      setCustomers(result);
      setCustomersLoaded(true);
      setContactId((current) => current || result[0]?.id || '');
      return result;
    });
  }, []);

  useEffect(() => {
    loadCustomers().catch(() => setCustomersLoaded(true));
  }, [loadCustomers]);

  async function handleCreateCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newCustomerName.trim()) return;
    setCreatingCustomer(true);
    setError(null);
    try {
      const contact = await createContact({
        displayName: newCustomerName.trim(),
        isCustomer: true,
      });
      setNewCustomerName('');
      await loadCustomers();
      setContactId(contact.id);
    } catch {
      setError('Could not create the customer. Please try again.');
    } finally {
      setCreatingCustomer(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!contactId) {
      setError('Select a customer.');
      return;
    }

    const result = parseLineDrafts(lines);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSubmitting(true);
    try {
      const invoice = await createInvoice({
        contactId,
        txnDate,
        memo: memo.trim() || undefined,
        lines: result.lines,
      });
      navigate(`/invoices/${invoice.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        const body = err.body as { message?: string } | null;
        setError(body?.message ?? 'Please check the invoice details and try again.');
      } else {
        setError('Could not create the invoice. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New invoice</h1>

      {customersLoaded && customers.length === 0 ? (
        <div>
          <p>You don't have any customers yet. Add one to create an invoice.</p>
          <form onSubmit={handleCreateCustomer}>
            <label htmlFor="new-customer-name">Customer name</label>
            <input
              id="new-customer-name"
              type="text"
              required
              value={newCustomerName}
              onChange={(event) => setNewCustomerName(event.target.value)}
            />
            <button type="submit" disabled={creatingCustomer}>
              {creatingCustomer ? 'Adding...' : 'Add customer'}
            </button>
          </form>
        </div>
      ) : null}

      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="invoice-customer">Customer</label>
          <select
            id="invoice-customer"
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
            disabled={customers.length === 0}
            required
          >
            <option value="" disabled>
              Select a customer
            </option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="invoice-date">Date</label>
          <input
            id="invoice-date"
            type="date"
            required
            value={txnDate}
            onChange={(event) => setTxnDate(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="invoice-memo">Memo</label>
          <input
            id="invoice-memo"
            type="text"
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
          />
        </div>

        <InvoiceLinesEditor lines={lines} onChange={setLines} />

        {error ? <p role="alert">{error}</p> : null}

        <button type="submit" disabled={submitting || customers.length === 0}>
          {submitting ? 'Creating...' : 'Create invoice'}
        </button>
      </form>
    </section>
  );
}
