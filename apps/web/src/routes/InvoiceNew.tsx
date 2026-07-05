import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  computeDraftTotal,
  emptyLineDraft,
  InvoiceLinesEditor,
  type LineDraft,
  parseLineDrafts,
} from '../components/InvoiceLinesEditor.tsx';
import { InvoiceSummary } from '../components/InvoiceSummary.tsx';
import { Button, Card, Input, PageHeader, Select } from '../components/ui/index.ts';
import type { Contact } from '../lib/api.ts';
import { ApiError, createContact, createInvoice, listContacts } from '../lib/api.ts';
import { color } from '../theme.ts';

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

  const noCustomers = customers.length === 0;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 30px 60px' }}>
      <PageHeader title="New invoice" subtitle="Post a customer invoice to the ledger." />

      {customersLoaded && noCustomers ? (
        <Card padding={18} style={{ marginBottom: 18 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: color.textMuted }}>
            You don't have any customers yet. Add one to create an invoice.
          </p>
          <form
            onSubmit={handleCreateCustomer}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}
          >
            <div style={{ flex: 1 }}>
              <Input
                label="Customer name"
                id="new-customer-name"
                type="text"
                required
                value={newCustomerName}
                onChange={(event) => setNewCustomerName(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={creatingCustomer}>
              {creatingCustomer ? 'Adding...' : 'Add customer'}
            </Button>
          </form>
        </Card>
      ) : null}

      <form onSubmit={handleSubmit}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 300px)',
            gap: 18,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Card header="Details" padding={18}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Select
                  label="Customer"
                  id="invoice-customer"
                  value={contactId}
                  onChange={(event) => setContactId(event.target.value)}
                  disabled={noCustomers}
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
                </Select>
                <Input
                  label="Date"
                  id="invoice-date"
                  type="date"
                  required
                  value={txnDate}
                  onChange={(event) => setTxnDate(event.target.value)}
                />
                <Input
                  label="Memo"
                  id="invoice-memo"
                  type="text"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                />
              </div>
            </Card>

            <Card header="Line items" padding={18}>
              <InvoiceLinesEditor lines={lines} onChange={setLines} />
            </Card>
          </div>

          <InvoiceSummary total={computeDraftTotal(lines)} error={error}>
            <Button
              type="submit"
              variant="primary"
              fullWidth
              height={42}
              disabled={submitting || noCustomers}
            >
              {submitting ? 'Creating...' : 'Create invoice'}
            </Button>
          </InvoiceSummary>
        </div>
      </form>
    </div>
  );
}
