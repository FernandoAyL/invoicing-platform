# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This repository implements a two-way invoice sync service between an internal invoicing system and QuickBooks Online (QBO). The service ingests change events from either side (invoice creation, updates, deletions/voids, payment status changes) and applies them safely to the other system, given that:

- events may be duplicated, delayed, or arrive out of order
- webhook payloads may be incomplete, requiring a refetch of full invoice state
- external API calls can fail or time out
- users can make manual, conflicting edits in both systems concurrently

Core requirements the design must satisfy:

1. **Mapping** — a clear correspondence between internal invoices/payments and QBO invoices/payments, plus sync of relevant GL entries and accounts.
2. **Idempotency** — duplicate events or retries must never create duplicate records or repeated writes.
3. **Conflict handling** — an explicit, defined strategy for resolving or flagging edits made to the same invoice in both systems.
4. **Auditability** — enough persisted history to explain what changed, what action was taken, and whether it succeeded.
5. **Failure handling** — retries, backoff, and safe recovery from partial success when a write to an external system times out or fails midway.

Notable edge cases the sync logic is expected to handle: duplicate webhook delivery, out-of-order events, the same invoice edited in both systems, delete-vs-void semantic differences, partially paid invoices being edited, timeout after a write to an external system, retry after partial success, and pre-existing invoices in both systems with no prior linkage record.

## Intended direction (not yet implemented)

- Node.js backend (runtime/package-manager choice still being decided, aimed at what's idiomatic for deploying Node.js on AWS today).
- Postgres as the system of record, running on AWS RDS in production.
- Container-based deployment on AWS Fargate; Terraform for infrastructure as code. A local Docker/docker-compose setup is intended to mirror this stack for development.
- Real sync testing against a QuickBooks Online (QBO) developer sandbox, not a mocked QBO API.
- A `docs/` folder is intended to hold a written explanation of the stack/tradeoff reasoning — check there for design rationale once it exists.
