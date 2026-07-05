import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  InvoiceLinesEditor,
  type LineDraft,
  lineDraftsFromInvoiceLines,
  parseLineDrafts,
} from '../components/InvoiceLinesEditor.tsx';
import type { Invoice } from '../lib/api.ts';
import { ApiError, getInvoice, updateInvoice } from '../lib/api.ts';

type LoadState = 'loading' | 'loaded' | 'not-found' | 'error';

// Basic edit: memo, due date, and line items. Only reachable (and only
// submittable) while the invoice is 'open' - the server 409s otherwise, and
// InvoiceDetail already hides the Edit link once the invoice leaves 'open',
// so this route's own guard below is the defense against a stale link / a
// race where the state changed in another tab after the link was rendered.
export default function InvoiceEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [memo, setMemo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getInvoice(id)
      .then((result) => {
        if (cancelled) return;
        setInvoice(result);
        setMemo(result.memo ?? '');
        setDueDate(result.dueDate ?? '');
        setLines(lineDraftsFromInvoiceLines(result.lines));
        setState('loaded');
      })
      .catch((err) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 404 ? 'not-found' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id) return;
    setError(null);

    const result = parseLineDrafts(lines);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSubmitting(true);
    try {
      await updateInvoice(id, {
        memo: memo.trim() || undefined,
        dueDate: dueDate || undefined,
        lines: result.lines,
      });
      navigate(`/invoices/${id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This invoice can no longer be edited. Returning to its details...');
        setTimeout(() => navigate(`/invoices/${id}`, { replace: true }), 1500);
      } else if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        const body = err.body as { message?: string } | null;
        setError(body?.message ?? 'Please check the invoice details and try again.');
      } else {
        setError('Could not save the invoice. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'loading') return <p role="status">Loading...</p>;
  if (state === 'not-found') return <p>Invoice not found.</p>;
  if (state === 'error' || !invoice) return <p role="alert">Could not load this invoice.</p>;

  if (invoice.status !== 'open') {
    return (
      <section>
        <h1>Edit invoice</h1>
        <p>This invoice can no longer be edited.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Edit invoice</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="edit-memo">Memo</label>
          <input
            id="edit-memo"
            type="text"
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="edit-due-date">Due date</label>
          <input
            id="edit-due-date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </div>

        <InvoiceLinesEditor lines={lines} onChange={setLines} />

        {error ? <p role="alert">{error}</p> : null}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : 'Save changes'}
        </button>
      </form>
    </section>
  );
}
