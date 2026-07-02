# PRD: Invoicing Platform

## Overview

A web platform where a business creates and sends customer invoices, records payments against them, and keeps QuickBooks Online as its accounting system of record — bidirectionally and automatically, without double entry or silent data loss when both sides are edited.

## Goals

- One dashboard to create, view, and manage customer invoices and their payment status.
- Every invoice and payment stays in sync with QuickBooks Online in both directions, correctly handling duplicate events, out-of-order delivery, and edits made concurrently in both systems.
- Single organization for now, but the data model and auth are org-scoped from day one so a second organization is a matter of adding org creation/switching UI, not a schema rewrite.

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

`Organization` (single row today, present so nothing else needs to change to add a second) → `User`, `Customer`, `Invoice`, `Payment`, `QboConnection` (OAuth tokens, one per org), `SyncLink` (maps internal invoice/payment IDs to QBO IDs), `SyncAuditLog` (append-only: entity, action, direction, outcome, timestamp, triggering event).

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

- **OCR invoice ingestion** — upload a document and auto-extract vendor, amount, and line items instead of manual entry.
- **Sync Copilot (suggested)** — surface likely conflicts before they fully land, and suggest a resolution, extending the conflict-handling policy above. Flagged as a direction to confirm, not a commitment.

## Assumptions

- "Invoice" and "payment" refer to QuickBooks Online's AR objects (Invoice, Payment) — customer-facing billing, not vendor bill pay.
- Sync is tested against a real QuickBooks Online developer sandbox, not a mocked API.
- Single organization is seeded; no self-serve org creation in this phase.
