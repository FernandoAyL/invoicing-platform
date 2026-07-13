// Typed fetch client for /api/*. Same-origin, httpOnly cookie auth: every
// call sends `credentials: 'include'` and the frontend never reads or sets
// the session cookie itself (see rules/payments-adjacent architecture-decisions.md
// "Frontend deployment" - no CORS, no token in JS).

export interface CurrentUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...restInit } = init ?? {};
  // Only declare a JSON Content-Type when we're actually sending a JSON body.
  // Fastify's default body parser rejects a request that declares
  // `Content-Type: application/json` but has an empty body with
  // `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the route handler runs — so a
  // bodyless call (e.g. logout) must omit the header entirely.
  const hasBody = restInit.body !== undefined;

  const response = await fetch(path, {
    credentials: 'include',
    ...restInit,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...initHeaders,
    },
  });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; leave `body` as null.
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function login(email: string, password: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}

export function me(): Promise<CurrentUser> {
  return request<CurrentUser>('/api/auth/me');
}

// ---------------------------------------------------------------------------
// Invoices, payments, contacts, accounts. These mirror the server response
// shapes verbatim (apps/api/src/routes/{invoices,payments,contacts,accounts}.ts) -
// the client never re-derives amounts or status, only formats/orchestrates.

export type InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void';
export type SyncState = 'pending' | 'synced' | 'conflict' | 'failed';

export interface InvoiceLine {
  id: string;
  lineNumber: number;
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface Invoice {
  id: string;
  type: 'customer_invoice';
  status: InvoiceStatus;
  contactId: string | null;
  docNumber: string | null;
  txnDate: string;
  dueDate: string | null;
  currency: string;
  memo: string | null;
  subtotal: string;
  total: string;
  balance: string;
  version: number;
  syncState: SyncState;
  /** Deep link to this invoice in the QuickBooks web app, or null when it isn't linked yet. */
  qboUrl: string | null;
  lines: InvoiceLine[];
}

export interface InvoiceLineInput {
  itemId?: string;
  accountId?: string;
  description?: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateInvoiceInput {
  contactId: string;
  txnDate: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines: InvoiceLineInput[];
}

export interface UpdateInvoiceInput {
  contactId?: string;
  txnDate?: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines?: InvoiceLineInput[];
}

export interface ListInvoicesParams {
  status?: InvoiceStatus;
}

export function listInvoices(params: ListInvoicesParams = {}): Promise<Invoice[]> {
  const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : '';
  return request<Invoice[]>(`/api/invoices${qs}`);
}

export function getInvoice(id: string): Promise<Invoice> {
  return request<Invoice>(`/api/invoices/${id}`);
}

export function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  return request<Invoice>('/api/invoices', { method: 'POST', body: JSON.stringify(input) });
}

export function updateInvoice(id: string, input: UpdateInvoiceInput): Promise<Invoice> {
  return request<Invoice>(`/api/invoices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function voidInvoice(id: string): Promise<Invoice> {
  return request<Invoice>(`/api/invoices/${id}/void`, { method: 'POST' });
}

// Ledger postings (10018) — read-only, org-scoped double-entry rows for a single invoice.
// Mirrors apps/api/src/routes/invoices.ts's GET /api/invoices/:id/ledger verbatim.

export interface LedgerPosting {
  id: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountSubtype: string | null;
  entryDate: string;
  debit: string;
  credit: string;
}

export interface InvoiceLedger {
  entries: LedgerPosting[];
  totalDebit: string;
  totalCredit: string;
}

export function getInvoiceLedger(invoiceId: string): Promise<InvoiceLedger> {
  return request<InvoiceLedger>(`/api/invoices/${invoiceId}/ledger`);
}

export interface Payment {
  id: string;
  type: 'payment';
  status: string;
  contactId: string | null;
  txnDate: string;
  memo: string | null;
  amount: string;
  version: number;
}

export interface InvoiceSummary {
  id: string;
  status: string;
  balance: string;
  version: number;
}

export interface RecordPaymentResult {
  payment: Payment;
  invoice: InvoiceSummary;
}

export interface RecordPaymentInput {
  amount: number;
  txnDate: string;
  depositAccountId?: string;
  memo?: string;
}

export function listPayments(invoiceId: string): Promise<Payment[]> {
  return request<Payment[]>(`/api/invoices/${invoiceId}/payments`);
}

export function recordPayment(
  invoiceId: string,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  return request<RecordPaymentResult>(`/api/invoices/${invoiceId}/payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function voidPayment(paymentId: string): Promise<RecordPaymentResult> {
  return request<RecordPaymentResult>(`/api/payments/${paymentId}/void`, { method: 'POST' });
}

export interface Contact {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isVendor: boolean;
  isEmployee: boolean;
  isActive: boolean;
  syncState: SyncState;
  /** Deep link to this customer in the QuickBooks web app, or null when it isn't linked yet. */
  qboUrl: string | null;
}

export interface CreateContactInput {
  displayName: string;
  email?: string;
  phone?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
}

export interface ListContactsParams {
  role?: 'customer' | 'vendor' | 'employee';
  includeInactive?: boolean;
}

export function listContacts(params: ListContactsParams = {}): Promise<Contact[]> {
  const qp = new URLSearchParams();
  if (params.role) qp.set('role', params.role);
  if (params.includeInactive) qp.set('includeInactive', 'true');
  const qs = qp.toString();
  return request<Contact[]>(`/api/contacts${qs ? `?${qs}` : ''}`);
}

export function getContact(id: string): Promise<Contact> {
  return request<Contact>(`/api/contacts/${id}`);
}

export function createContact(input: CreateContactInput): Promise<Contact> {
  return request<Contact>('/api/contacts', { method: 'POST', body: JSON.stringify(input) });
}

export type UpdateContactInput = Partial<CreateContactInput>;

export function updateContact(id: string, input: UpdateContactInput): Promise<Contact> {
  return request<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function archiveContact(id: string): Promise<void> {
  return request<void>(`/api/contacts/${id}`, { method: 'DELETE' });
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: string;
  code: string | null;
  name: string;
  type: AccountType;
  subtype: string | null;
  currency: string;
  isActive: boolean;
}

export interface ListAccountsParams {
  type?: AccountType;
  includeInactive?: boolean;
}

export function listAccounts(params: ListAccountsParams = {}): Promise<Account[]> {
  const qp = new URLSearchParams();
  if (params.type) qp.set('type', params.type);
  if (params.includeInactive) qp.set('includeInactive', 'true');
  const qs = qp.toString();
  return request<Account[]>(`/api/accounts${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// Conflicts (20010) — mirrors apps/api/src/routes/conflicts.ts verbatim.

export interface ConflictTransactionSummary {
  id: string;
  type: 'customer_invoice' | 'payment';
  docNumber: string | null;
  total: string;
  status: string;
  deletedAt: string | null;
  updatedAt: string;
}

export interface Conflict {
  linkId: string;
  qboType: 'Invoice' | 'Payment';
  qboId: string;
  conflictDetectedAt: string | null;
  storedSyncToken: string | null;
  storedLocalVersion: number | null;
  localCurrentVersion: number | null;
  transaction: ConflictTransactionSummary | null;
}

export type ConflictWinner = 'local' | 'qbo';

export interface ResolveConflictResult {
  linkId: string;
  state: SyncState;
  winner: ConflictWinner;
}

export function listConflicts(): Promise<Conflict[]> {
  return request<Conflict[]>('/api/conflicts');
}

export function resolveConflict(
  linkId: string,
  winner: ConflictWinner,
): Promise<ResolveConflictResult> {
  return request<ResolveConflictResult>(`/api/conflicts/${linkId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ winner }),
  });
}

// ---------------------------------------------------------------------------
// Integrations (20012) — connect/disconnect QBO, connection health, failed-item
// retry, and the sync activity log. Mirrors apps/api/src/routes/{integrations,
// sync-failures,sync-activity}.ts verbatim.

export interface QboStatus {
  connected: boolean;
  realmId: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

export function qboStatus(): Promise<QboStatus> {
  return request<QboStatus>('/api/integrations/qbo/status');
}

/** Kicks off the OAuth connect flow by navigating the browser to Intuit's authorize URL. Throws
 * the underlying `ApiError` (e.g. 503 `qbo_not_configured`) for the caller to catch and message —
 * it does not swallow errors itself. */
export async function connectQbo(): Promise<void> {
  const { authorizeUrl } = await request<{ authorizeUrl: string }>('/api/integrations/qbo/connect');
  window.location.assign(authorizeUrl);
}

export function disconnectQbo(): Promise<{ connected: boolean }> {
  return request<{ connected: boolean }>('/api/integrations/qbo/disconnect', { method: 'POST' });
}

export interface SyncFailureTransactionSummary {
  id: string;
  type: 'customer_invoice' | 'payment';
  docNumber: string | null;
  total: string;
  status: string;
}

export interface SyncFailure {
  linkId: string;
  entityType: string;
  qboType: string;
  qboId: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  transaction: SyncFailureTransactionSummary | null;
}

export function listSyncFailures(): Promise<SyncFailure[]> {
  return request<SyncFailure[]>('/api/sync/failures');
}

export interface RetrySyncFailureResult {
  linkId: string;
  outcome: string;
  state: SyncState | null;
  qboId: string | null;
}

export function retrySyncFailure(linkId: string): Promise<RetrySyncFailureResult> {
  return request<RetrySyncFailureResult>(`/api/sync/failures/${linkId}/retry`, {
    method: 'POST',
  });
}

export type SyncActivityDirection = 'inbound' | 'outbound' | 'local';
export type SyncActivityOutcome = 'success' | 'failure' | 'skipped';

export interface SyncActivityEntry {
  id: string;
  entityType: string | null;
  localId: string | null;
  action: string;
  direction: SyncActivityDirection;
  outcome: SyncActivityOutcome;
  triggeringEvent: string | null;
  detail: unknown;
  createdAt: string;
}

export function listSyncActivity(limit?: number): Promise<SyncActivityEntry[]> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return request<SyncActivityEntry[]>(`/api/sync/activity${qs}`);
}
