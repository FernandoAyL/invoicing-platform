import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import {
  archiveContact,
  type Contact,
  type ContactWithSync,
  createContact,
  getContactWithSync,
  listContactsWithSync,
  updateContact,
} from '../contacts/service.ts';
import { qboEntityUrl } from '../qbo/deep-link.ts';

const qboEnvironment = config.qbo?.environment ?? 'sandbox';

interface CreateContactBody {
  displayName: string;
  email?: string;
  phone?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
}

type UpdateContactBody = Partial<CreateContactBody>;

interface ListContactsQuery {
  role?: 'customer' | 'vendor' | 'employee';
  includeInactive?: boolean;
}

const contactBodySchema = {
  type: 'object',
  required: ['displayName'],
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    isCustomer: { type: 'boolean' },
    isVendor: { type: 'boolean' },
    isEmployee: { type: 'boolean' },
  },
} as const;

const updateContactBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    isCustomer: { type: 'boolean' },
    isVendor: { type: 'boolean' },
    isEmployee: { type: 'boolean' },
  },
} as const;

const listContactsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['customer', 'vendor', 'employee'] },
    includeInactive: { type: 'boolean', default: false },
  },
} as const;

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

function serialize(contact: Contact | ContactWithSync) {
  const syncState = 'syncState' in contact ? contact.syncState : 'pending';
  const qboId = 'qboId' in contact ? contact.qboId : null;
  return {
    id: contact.id,
    displayName: contact.displayName,
    email: contact.email,
    phone: contact.phone,
    isCustomer: contact.isCustomer,
    isVendor: contact.isVendor,
    isEmployee: contact.isEmployee,
    isActive: contact.isActive,
    syncState,
    qboUrl: qboEntityUrl(qboEnvironment, 'Customer', qboId),
  };
}

export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateContactBody }>(
    '/api/contacts',
    { schema: { body: contactBodySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const contact = await createContact(app.db, user.orgId, user.id, request.body);
      reply.code(201);
      return serialize(contact);
    },
  );

  app.get<{ Querystring: ListContactsQuery }>(
    '/api/contacts',
    { schema: { querystring: listContactsQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const result = await listContactsWithSync(app.db, user.orgId, {
        role: request.query.role,
        includeInactive: request.query.includeInactive ?? false,
      });
      return result.map(serialize);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/contacts/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const contact = await getContactWithSync(app.db, user.orgId, request.params.id);
      if (!contact) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      return serialize(contact);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateContactBody }>(
    '/api/contacts/:id',
    {
      schema: { params: idParamSchema, body: updateContactBodySchema },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const contact = await updateContact(
        app.db,
        user.orgId,
        user.id,
        request.params.id,
        request.body,
      );
      if (!contact) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      return serialize(contact);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/contacts/:id',
    { schema: { params: idParamSchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: 'unauthenticated' });
        return;
      }
      const archived = await archiveContact(app.db, user.orgId, user.id, request.params.id);
      if (!archived) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      reply.code(204);
    },
  );
}
