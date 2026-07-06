import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const userRole = pgEnum('user_role', ['admin', 'member']);

export const accountType = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

export const transactionType = pgEnum('transaction_type', [
  'customer_invoice',
  'vendor_bill',
  'customer_credit_memo',
  'vendor_credit',
  'payment',
  'bill_payment',
  'expense',
  'transfer',
  'journal_entry',
]);

export const transactionStatus = pgEnum('transaction_status', [
  'draft',
  'open',
  'partially_paid',
  'paid',
  'void',
]);

export const syncEntityType = pgEnum('sync_entity_type', [
  'contact',
  'account',
  'item',
  'transaction',
]);

export const syncState = pgEnum('sync_state', ['pending', 'synced', 'conflict', 'failed']);

export const syncDirection = pgEnum('sync_direction', ['inbound', 'outbound', 'local']);

export const syncOutcome = pgEnum('sync_outcome', ['success', 'failure', 'skipped']);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    ...timestamps,
  },
  (t) => [unique('users_email_unique').on(t.email), index('users_org_idx').on(t.orgId)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    displayName: text('display_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    isCustomer: boolean('is_customer').notNull().default(false),
    isVendor: boolean('is_vendor').notNull().default(false),
    isEmployee: boolean('is_employee').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('contacts_org_idx').on(t.orgId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    code: text('code'),
    name: text('name').notNull(),
    type: accountType('type').notNull(),
    subtype: text('subtype'),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id),
    currency: text('currency').notNull().default('USD'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('accounts_org_idx').on(t.orgId)],
);

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    sku: text('sku'),
    kind: text('kind').notNull().default('service'),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id),
    defaultPrice: money('default_price'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('items_org_idx').on(t.orgId)],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    type: transactionType('type').notNull(),
    status: transactionStatus('status').notNull().default('draft'),
    contactId: uuid('contact_id').references(() => contacts.id),
    docNumber: text('doc_number'),
    txnDate: date('txn_date').notNull(),
    dueDate: date('due_date'),
    currency: text('currency').notNull().default('USD'),
    memo: text('memo'),
    subtotal: money('subtotal').notNull().default('0'),
    total: money('total').notNull().default('0'),
    balance: money('balance').notNull().default('0'),
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    // Soft-delete marker (20009 §Delete-vs-void): NULL means live/visible everywhere; a non-null
    // timestamp means the record is invisible to every read path (getInvoice/listInvoices,
    // payment reads) but the row + its ledger/sync_links/payment_applications are retained —
    // deleting hard would destroy the reconciliation/idempotency trail and let the sync engine
    // re-create the record on the next push. Orthogonal to `status`: a deleted transaction keeps
    // whatever `status` it had (e.g. 'open' or 'void') — deletion is not a status value. See
    // docs/design-decisions.md ## Delete vs void.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('transactions_org_idx').on(t.orgId),
    index('transactions_contact_idx').on(t.contactId),
  ],
);

export const transactionLines = pgTable(
  'transaction_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    itemId: uuid('item_id').references(() => items.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    description: text('description'),
    quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull().default('1'),
    unitPrice: money('unit_price').notNull().default('0'),
    amount: money('amount').notNull().default('0'),
    ...timestamps,
  },
  (t) => [index('transaction_lines_txn_idx').on(t.transactionId)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    entryDate: date('entry_date').notNull(),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_txn_idx').on(t.transactionId),
    index('ledger_entries_account_idx').on(t.accountId),
  ],
);

export const paymentApplications = pgTable(
  'payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    paymentTxnId: uuid('payment_txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    invoiceTxnId: uuid('invoice_txn_id')
      .notNull()
      .references(() => transactions.id),
    amount: money('amount').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_applications_payment_idx').on(t.paymentTxnId),
    index('payment_applications_invoice_idx').on(t.invoiceTxnId),
  ],
);

export const qboConnections = pgTable(
  'qbo_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    realmId: text('realm_id').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique('qbo_connections_org_unique').on(t.orgId)],
);

export const syncLinks = pgTable(
  'sync_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    entityType: syncEntityType('entity_type').notNull(),
    localId: uuid('local_id').notNull(),
    qboType: text('qbo_type').notNull(),
    qboId: text('qbo_id').notNull(),
    state: syncState('state').notNull().default('pending'),
    localVersion: integer('local_version'),
    qboSyncToken: text('qbo_sync_token'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('sync_links_local_unique').on(t.orgId, t.entityType, t.localId),
    unique('sync_links_qbo_unique').on(t.orgId, t.qboType, t.qboId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const syncAuditLogs = pgTable(
  'sync_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    entityType: text('entity_type'),
    localId: uuid('local_id'),
    action: text('action').notNull(),
    direction: syncDirection('direction').notNull(),
    outcome: syncOutcome('outcome').notNull(),
    triggeringEvent: text('triggering_event'),
    detail: jsonb('detail'),
    userId: uuid('user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_audit_logs_org_idx').on(t.orgId)],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    eventKey: text('event_key').notNull(),
    realmId: text('realm_id').notNull(),
    entityName: text('entity_name').notNull(),
    entityId: text('entity_id').notNull(),
    operation: text('operation').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('processed_events_key_unique').on(t.orgId, t.eventKey),
    index('processed_events_org_idx').on(t.orgId),
  ],
);
