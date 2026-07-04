import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { Contact } from '../lib/api.ts';
import { archiveContact, createContact, listContacts } from '../lib/api.ts';

type LoadState = 'loading' | 'loaded' | 'error';

// Minimal customer management - just enough to attach a customer to an
// invoice (create-invoice's "add customer" inline form covers the same
// create path; this page is for browsing/archiving the full list).
export default function Customers() {
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState('loading');
    listContacts({ role: 'customer' })
      .then((result) => {
        setCustomers(result);
        setState('loaded');
      })
      .catch(() => setState('error'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createContact({
        displayName: displayName.trim(),
        email: email.trim() || undefined,
        isCustomer: true,
      });
      setDisplayName('');
      setEmail('');
      load();
    } catch {
      setError('Could not create the customer.');
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(id: string) {
    setError(null);
    try {
      await archiveContact(id);
      load();
    } catch {
      setError('Could not archive this customer.');
    }
  }

  return (
    <section>
      <h1>Customers</h1>

      <form onSubmit={handleCreate}>
        <label htmlFor="customer-name">Name</label>
        <input
          id="customer-name"
          type="text"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <label htmlFor="customer-email">Email</label>
        <input
          id="customer-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={creating}>
          {creating ? 'Adding...' : 'Add customer'}
        </button>
      </form>

      {error ? <p role="alert">{error}</p> : null}
      {state === 'loading' ? <p role="status">Loading...</p> : null}
      {state === 'error' ? <p role="alert">Could not load customers.</p> : null}
      {state === 'loaded' && customers.length === 0 ? <p>No customers yet.</p> : null}
      {state === 'loaded' && customers.length > 0 ? (
        <ul>
          {customers.map((customer) => (
            <li key={customer.id}>
              {customer.displayName}
              {customer.email ? ` (${customer.email})` : ''}
              <button type="button" onClick={() => handleArchive(customer.id)}>
                Archive
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
