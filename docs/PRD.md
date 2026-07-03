# PRD: Invoicing Platform

## Overview

A web platform where a business creates and sends customer invoices, records payments against them, and keeps QuickBooks Online as its accounting system of record — bidirectionally and automatically, without double entry or silent data loss when both sides are edited.

## Goals

- One dashboard to create, view, and manage customer invoices and their payment status.
- Every invoice and payment stays in sync with QuickBooks Online in both directions, correctly handling duplicate events, out-of-order delivery, and edits made concurrently in both systems.
- Single organization for now, but the data model and auth are org-scoped from day one so a second organization is a matter of adding org creation/switching UI, not a schema rewrite.
- Built on a simplified double-entry accounting core — a chart of accounts plus balanced ledger postings, modeled on how QuickBooks keeps its books — so the first customer-invoice slice and every later document type (vendor bills, refunds, expenses) share one ledger and one reporting surface.

## Scope & phasing

The first delivery is **customer invoices**, end to end: create / edit / void, record payments, and two-way sync with QuickBooks Online. **Vendor bills** (accounts payable) are the immediate stretch in this cycle if time allows — the same document and ledger model, differing mainly in direction and the accounts they post to.

Everything beyond that is deliberately **designed-for, not built yet**: customer credit memos / refunds, vendor credits, employee credit-card expenses, bank-account and transfer handling, and financial reports (General Ledger, Trial Balance, Profit & Loss, Balance Sheet). The data model accommodates each as an additive document `type` or a read-only query over the ledger — none require a schema rewrite.

## Non-goals

- **Payment processing.** The platform reflects payment status (paid/partial/unpaid); it does not move money or settle transactions itself.
- **Multi-tenant UI.** No org creation, invites, or org switching in this phase — the schema supports it, the product doesn't expose it yet.
- **OCR ingestion and the AI feature.** Noted as future direction (below), not specified or built in this phase.
- Multi-currency, tax calculation, and other accounting-engine features beyond what QBO already provides.

## Users

Single organization, two roles:
- **Admin** — manages the QuickBooks connection, can view the full sync audit log.
- **Member** — creates/edits invoices and records payments.

Both roles authenticate via session login (httpOnly cookie); every action is attributed to a user for the audit trail.

## Core surfaces

1. **Auth** — email/password login, session cookie, logout. No self-serve signup in this phase (seeded users).
2. **Invoices** — create, edit, void a customer invoice; attach a customer; record a payment against it; see each invoice's current QuickBooks sync status (synced / pending / conflict / failed) inline.
3. **Customers** — minimal record (name, contact info) required to attach to an invoice and to map to a QuickBooks Customer.
4. **Integrations page** — connect/disconnect QuickBooks Online via OAuth, view connection health, view a chronological sync activity log (what changed, what action was taken, success or failure), and manually retry a failed sync item. This is the Ramp-style pattern being reused here: a dedicated settings surface for the external accounting connection, separate from the main invoicing dashboard.
5. **Sync engine** (backend, no direct UI beyond the Integrations page) — ingests changes from both sides, refetches full invoice state when a webhook payload is incomplete, applies updates idempotently, and resolves or flags conflicting edits.

## Data model (high level)

The books are a **simplified double-entry ledger**, structured the way QuickBooks structures its own. One document model and one ledger cover every transaction type, so new document kinds are new rows and new enum values — not new tables.

```
Organization   (every table below is org-scoped via org_id)
|
|-- User
|-- Contact ......... customer / vendor / employee (role flags)
|-- Account ......... chart of accounts: type + subtype (bank / credit_card too)
|-- Item ............ product / service -> default income/expense Account
|
|-- Transaction ..... unified document header; one row per invoice / bill /
|     |               payment / expense / ..., distinguished by `type`
|     |               contact_id -> Contact
|     |
|     |--< TransactionLine ... editable lines
|     |        item_id    -> Item
|     |        account_id -> Account (income / expense)
|     |
|     `--< LedgerEntry ....... immutable postings; sum(debit) = sum(credit)
|              account_id -> Account
|              contact_id -> Contact
|
|-- QboConnection ... OAuth tokens (one per org)
|-- SyncLink ........ internal record <-> QBO id + type
`-- SyncAuditLog .... append-only: entity, action, direction, outcome, timestamp

  ( --< = one-to-many )
```

**Org & parties**
- `Organization` — single row today; everything is org-scoped so a second org is additive.
- `User` — authenticates; every action is attributed to one for the audit trail.
- `Contact` — a party that can hold any of the **customer / vendor / employee** roles (role flags), unifying what QuickBooks splits into three separate name lists. Maps to the matching QBO entity. Only the customer role is exercised in the first delivery.

**Chart of accounts**
- `Account` — the chart of accounts: `type` (`asset` | `liability` | `equity` | `income` | `expense`) plus `subtype` (e.g. `accounts_receivable`, `sales_income`, `bank`, `undeposited_funds`, `accounts_payable`, `credit_card`), with an optional `parent_id` for hierarchy. **Bank accounts** and **employee credit cards** are simply Accounts with subtype `bank` / `credit_card` (a card optionally linked to an employee `Contact`) — no separate tables. Maps to a QBO Account.
- `Item` — a sellable / purchasable product or service pointing at a default income / expense `Account`; QBO requires an Item on invoice lines. Minimal in the first delivery.

**Documents (source transactions)**
- `Transaction` — the unified document header: `type` (`customer_invoice`, `vendor_bill`, `customer_credit_memo`, `vendor_credit`, `payment`, `bill_payment`, `expense`, `transfer`, `journal_entry`), `date`, `contact_id`, `status`, `currency`, `memo`, totals. Every document kind lives in this one table.
- `TransactionLine` — the human-facing lines of a document (invoice / bill line items): `item_id`, description, quantity, unit price, amount, and the income / expense `account_id` the line hits. This is what users edit.

**The ledger (system of record for reporting)**
- `LedgerEntry` — immutable double-entry postings: `transaction_id`, `account_id`, `contact_id`, `date`, `debit`, `credit`. Every `Transaction` posts a **balanced** set (Σ debit = Σ credit). This is the general ledger; all financial reports are read-only queries over it:
  - **General Ledger** — entries grouped by account over a date range.
  - **Trial Balance** — Σ debit / Σ credit per account.
  - **Profit & Loss** — income − expense accounts over a period.
  - **Balance Sheet** — assets = liabilities + equity at a date.

**Sync**
- `QboConnection` — OAuth tokens, one per org.
- `SyncLink` — entity-typed mapping between an internal record (`Contact` / `Account` / `Item` / `Transaction`) and its QBO id + type.
- `SyncAuditLog` — append-only: entity, action, direction, outcome, timestamp, triggering event.

*Worked example — a $100 services invoice:* a `Transaction{type: customer_invoice}` with one `TransactionLine{amount 100, account: Sales Income}` posts `LedgerEntry` **debit Accounts Receivable 100 / credit Sales Income 100**. Recording payment posts a second `Transaction{type: payment}` — **debit Bank 100 / credit Accounts Receivable 100** — and flips the invoice to paid. Vendor bills, refunds, and card expenses are the same shape with a different `type` and different accounts.

## Sync boundary

Sync happens at the **document level, not the ledger level.** Each system derives its own general ledger from the documents it holds:

- Pushing a `customer_invoice` to QBO lets **QBO auto-post its own GL** (debit A/R, credit income); an inbound change makes **our** posting logic write our `LedgerEntry` rows. Ledger postings never cross the wire.
- Because each side derives its own ledger, our posting rules **mirror QBO's standard accounting behavior** for the same document, so the two ledgers stay equivalent without being reconciled directly. QBO remains the accounting system of record.
- Reference data a document points at (party, accounts, items) is mapped first, so both sides reference the same records.

| Entity | Synced? | Why |
|--------|---------|-----|
| `Contact` (customer / vendor) | **Yes** | Documents attach to a party; QBO needs the Customer/Vendor ID |
| `Account` (chart of accounts) | **Yes** | Lines and payments post to accounts; both sides must agree on which |
| `Item` | **Yes** | QBO requires an Item on invoice lines |
| `Transaction` (invoice / bill / payment / …) | **Yes** | The documents themselves — mapped to QBO's typed entity by `type` |
| `TransactionLine` | **Yes** | Travels inside its `Transaction` (embedded `Line[]` in QBO) |
| `LedgerEntry` | **No** | Internal only — each system derives its own general ledger from the documents |

## Conflict resolution policy

If an invoice was edited in both systems since the last successful sync, the sync engine does not guess — it flags the invoice as **conflict** in the Integrations log and on the invoice itself, and requires a user to pick which version wins before either side is written again. No silent overwrites in either direction.

## Acceptance criteria

- Creating/editing/voiding an invoice in the app propagates to the QuickBooks sandbox, and vice versa.
- A duplicate or out-of-order webhook event never creates a duplicate invoice, payment, or repeated write.
- A payment status change on either side is reflected on the other.
- Void and delete are treated as distinct actions, matching QuickBooks' own void-vs-delete semantics.
- Every sync action (success or failure) is visible in the Integrations audit log with enough detail to explain what happened.
- A failed sync can be retried from the UI without manual database intervention.

## Future nice to have features

- **Full accounting surface** — vendor bills (AP) and bill payments, customer / vendor refunds and credit memos, employee credit-card expenses, bank accounts and transfers, and financial reports (General Ledger, Trial Balance, Profit & Loss, Balance Sheet) as read-only views over the same ledger. All additive on the data model above — new `Transaction` types and queries, not new tables.
- **OCR invoice ingestion** — upload a document and auto-extract vendor, amount, and line items instead of manual entry.
- **Sync Copilot (suggested)** — surface likely conflicts before they fully land, and suggest a resolution, extending the conflict-handling policy above. Flagged as a direction to confirm, not a commitment.

## Assumptions

- "Invoice" and "payment" in the first delivery refer to QuickBooks Online's AR objects (Invoice, Payment) — customer-facing billing. Vendor bill pay (AP) is a planned extension the model already accommodates, not part of the initial slice.
- Sync is tested against a real QuickBooks Online developer sandbox, not a mocked API.
- Single organization is seeded; no self-serve org creation in this phase.
