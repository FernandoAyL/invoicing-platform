import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ChartNotSeededError,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceLedger,
  InvalidContactError,
  InvalidLineError,
  InvalidStateError,
  type Invoice,
  type InvoiceLedger,
  type InvoiceStatus,
  listInvoices,
  NotFoundError,
  updateInvoice,
  voidInvoice,
} from '../invoices/service.ts';
import { pushInvoiceOutbound } from '../qbo/outbound-sync.ts';

interface InvoiceLineBody {
  itemId?: string;
  accountId?: string;
  description?: string;
  quantity: number;
  unitPrice: number;
}

interface CreateInvoiceBody {
  contactId: string;
  txnDate: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines: InvoiceLineBody[];
}

interface UpdateInvoiceBody {
  contactId?: string;
  txnDate?: string;
  dueDate?: string;
  memo?: string;
  docNumber?: string;
  lines?: InvoiceLineBody[];
}

interface ListInvoicesQuery {
  status?: InvoiceStatus;
}

const invoiceLineSchema = {
  type: 'object',
  required: ['quantity', 'unitPrice'],
  additionalProperties: false,
  properties: {
    itemId: { type: 'string', format: 'uuid' },
    accountId: { type: 'string', format: 'uuid' },
    description: { type: 'string' },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unitPrice: { type: 'number', minimum: 0 },
  },
} as const;

const createInvoiceBodySchema = {
  type: 'object',
  required: ['contactId', 'txnDate', 'lines'],
  additionalProperties: false,
  properties: {
    contactId: { type: 'string', format: 'uuid' },
    txnDate: { type: 'string', format: 'date' },
    dueDate: { type: 'string', format: 'date' },
    memo: { type: 'string' },
    docNumber: { type: 'string' },
    lines: { type: 'array', minItems: 1, items: invoiceLineSchema },
  },
} as const;

const updateInvoiceBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    contactId: { type: 'string', format: 'uuid' },
    txnDate: { type: 'string', format: 'date' },
    dueDate: { type: 'string', format: 'date' },
    memo: { type: 'string' },
    docNumber: { type: 'string' },
    lines: { type: 'array', minItems: 1, items: invoiceLineSchema },
  },
} as const;

const listInvoicesQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['draft', 'open', 'partially_paid', 'paid', 'void'] },
  },
} as const;

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

function serialize(invoice: Invoice) {
  return {
    id: invoice.id,
    type: invoice.type,
    status: invoice.status,
    contactId: invoice.contactId,
    docNumber: invoice.docNumber,
    txnDate: invoice.txnDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    memo: invoice.memo,
    subtotal: invoice.subtotal,
    total: invoice.total,
    balance: invoice.balance,
    version: invoice.version,
    syncState: invoice.syncState,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      accountId: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
  };
}

function serializeLedger(ledger: InvoiceLedger) {
  return {
    entries: ledger.entries.map((entry) => ({
      id: entry.id,
      accountId: entry.accountId,
      accountName: entry.accountName,
      accountCode: entry.accountCode,
      accountSubtype: entry.accountSubtype,
      entryDate: entry.entryDate,
      debit: entry.debit,
      credit: entry.credit,
    })),
    totalDebit: ledger.totalDebit,
    totalCredit: ledger.totalCredit,
  };
}

// Maps the invoice service's typed errors to HTTP status codes. Returns
// true if the error was handled (reply already sent); false means the
// caller should rethrow so an unexpected error still surfaces (as a 500,
// never with a leaked stack trace since Fastify's default handler only
// sends the message).
function mapServiceError(err: unknown, reply: FastifyReply): boolean {
  if (err instanceof NotFoundError) {
    reply.code(404).send({ error: 'not_found' });
    return true;
  }
  if (err instanceof InvalidStateError) {
    reply.code(409).send({ error: 'invalid_state', message: err.message });
    return true;
  }
  if (err instanceof ChartNotSeededError) {
    reply.code(409).send({ error: 'chart_not_seeded', message: err.message });
    return true;
  }
  if (err instanceof InvalidContactError) {
    reply.code(422).send({ error: 'invalid_contact', message: err.message });
    return true;
  }
  if (err instanceof InvalidLineError) {
    reply.code(400).send({ error: 'invalid_line', message: err.message });
    return true;
  }
  return false;
}

export default async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateInvoiceBody }>(
    '/api/invoices',
    { schema: { body: createInvoiceBodySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const invoice = await createInvoice(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.body,
        );
        await pushInvoiceOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: invoice.id,
          userId: user.id,
        });
        reply.code(201);
        return serialize(invoice);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  app.get<{ Querystring: ListInvoicesQuery }>(
    '/api/invoices',
    { schema: { querystring: listInvoicesQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const result = await listInvoices(app.db, user.orgId, { status: request.query.status });
      return result.map(serialize);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const invoice = await getInvoice(app.db, user.orgId, request.params.id);
      if (!invoice) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      return serialize(invoice);
    },
  );

  // Read-only (10018): org-scoped ledger-posting rows for this invoice. Mirrors the GET /:id
  // handler's auth/error shape; getInvoiceLedger throws NotFoundError for a
  // missing/cross-org/soft-deleted invoice, mapped to 404 like every other invoice route.
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/ledger',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const ledger = await getInvoiceLedger(app.db, user.orgId, request.params.id);
        return serializeLedger(ledger);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateInvoiceBody }>(
    '/api/invoices/:id',
    {
      schema: { params: idParamSchema, body: updateInvoiceBodySchema },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const invoice = await updateInvoice(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
          request.body,
        );
        await pushInvoiceOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: invoice.id,
          userId: user.id,
        });
        return serialize(invoice);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/void',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const invoice = await voidInvoice(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
        );
        await pushInvoiceOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: invoice.id,
          userId: user.id,
        });
        return serialize(invoice);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  // Distinct from `/void` (20009, docs/design-decisions.md ## Delete vs void): soft-deletes the
  // invoice (invisible to every read path from here on — a subsequent GET 404s) rather than
  // keeping it visible-but-zeroed. Idempotent: deleting an already-deleted invoice returns the
  // same 200 shape instead of a 404/error.
  app.delete<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const result = await deleteInvoice(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
        );
        await pushInvoiceOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: result.invoice.id,
          userId: user.id,
        });
        return serialize(result.invoice);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );
}
