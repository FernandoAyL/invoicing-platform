import type { FastifyInstance } from 'fastify';
import { type Account, type AccountType, listAccounts } from '../accounts/service.ts';

interface ListAccountsQuery {
  includeInactive?: boolean;
  type?: AccountType;
}

const listAccountsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    includeInactive: { type: 'boolean', default: false },
    type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
  },
} as const;

function serialize(account: Account) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    currency: account.currency,
    isActive: account.isActive,
  };
}

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListAccountsQuery }>(
    '/api/accounts',
    { schema: { querystring: listAccountsQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const result = await listAccounts(app.db, user.orgId, {
        includeInactive: request.query.includeInactive ?? false,
        type: request.query.type,
      });
      return result.map(serialize);
    },
  );
}
