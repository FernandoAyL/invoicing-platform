import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ChartNotSeededError,
  type DeletePaymentResult,
  deletePayment,
  getPayment,
  InvalidAmountError,
  InvalidDepositAccountError,
  InvalidStateError,
  listPaymentsForInvoice,
  NotFoundError,
  OverpaymentError,
  type Payment,
  type RecordPaymentResult,
  recordPayment,
  VersionConflictError,
  type VoidPaymentResult,
  voidPayment,
} from '../payments/service.ts';
import { pushPaymentOutbound } from '../qbo/outbound-sync.ts';

interface RecordPaymentBody {
  amount: number;
  txnDate: string;
  depositAccountId?: string;
  memo?: string;
}

const recordPaymentBodySchema = {
  type: 'object',
  required: ['amount', 'txnDate'],
  additionalProperties: false,
  properties: {
    amount: { type: 'number', exclusiveMinimum: 0 },
    txnDate: { type: 'string', format: 'date' },
    depositAccountId: { type: 'string', format: 'uuid' },
    memo: { type: 'string' },
  },
} as const;

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

function serializePayment(payment: Payment) {
  return {
    id: payment.id,
    type: payment.type,
    status: payment.status,
    contactId: payment.contactId,
    txnDate: payment.txnDate,
    memo: payment.memo,
    amount: payment.total,
    version: payment.version,
  };
}

function serializeResult(result: RecordPaymentResult | VoidPaymentResult | DeletePaymentResult) {
  return {
    payment: serializePayment(result.payment),
    invoice: result.invoice,
  };
}

// Maps the payments service's typed errors to HTTP status codes. Returns
// true if the error was handled (reply already sent); false means the
// caller should rethrow so an unexpected error still surfaces (as a 500,
// never with a leaked stack trace).
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
  // 30022: rare — only reachable when `voidPayment`/`deletePayment`'s unlocked recompute races
  // another writer on the same invoice (`recordPayment` itself is already race-free via 30021's
  // row lock). A 409 "try again" beats an unmapped 500.
  if (err instanceof VersionConflictError) {
    reply.code(409).send({ error: 'version_conflict', message: err.message });
    return true;
  }
  if (err instanceof OverpaymentError) {
    reply.code(422).send({ error: 'overpayment', message: err.message });
    return true;
  }
  if (err instanceof InvalidDepositAccountError) {
    reply.code(422).send({ error: 'invalid_deposit_account', message: err.message });
    return true;
  }
  if (err instanceof InvalidAmountError) {
    reply.code(400).send({ error: 'invalid_amount', message: err.message });
    return true;
  }
  return false;
}

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: RecordPaymentBody }>(
    '/api/invoices/:id/payments',
    {
      schema: { params: idParamSchema, body: recordPaymentBodySchema },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const result = await recordPayment(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
          request.body,
        );
        await pushPaymentOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: result.payment.id,
          userId: user.id,
        });
        reply.code(201);
        return serializeResult(result);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/payments',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const payments = await listPaymentsForInvoice(app.db, user.orgId, request.params.id);
        return payments.map(serializePayment);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/payments/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const payment = await getPayment(app.db, user.orgId, request.params.id);
      if (!payment) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      return serializePayment(payment);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/payments/:id/void',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const result = await voidPayment(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
        );
        await pushPaymentOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: result.payment.id,
          userId: user.id,
        });
        return serializeResult(result);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );

  // Distinct from `/void` (20009) — soft-deletes the payment (invisible to every read path from
  // here on) rather than keeping it visible-but-zeroed. Idempotent on an already-deleted payment.
  app.delete<{ Params: { id: string } }>(
    '/api/payments/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      try {
        const result = await deletePayment(
          app.db,
          { orgId: user.orgId, userId: user.id },
          request.params.id,
        );
        await pushPaymentOutbound(app.db, app.qboOAuthClient, app.qboApiClient, {
          orgId: user.orgId,
          txnId: result.payment.id,
          userId: user.id,
        });
        return serializeResult(result);
      } catch (err) {
        if (mapServiceError(err, reply)) return;
        throw err;
      }
    },
  );
}
