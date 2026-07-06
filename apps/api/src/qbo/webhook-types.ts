export interface WebhookEntity {
  name: string;
  id: string;
  operation: string;
  lastUpdated?: string;
}

export interface WebhookEventNotification {
  realmId: string;
  entities: WebhookEntity[];
}

export interface WebhookBody {
  eventNotifications: Array<{
    realmId: string;
    dataChangeEvent: {
      entities: WebhookEntity[];
    };
  }>;
}

// QBO's own intuit-webhooks-payload shape. `operation` is kept permissive (QBO's full set,
// including Merge/Void/Emailed) — this task only records the receipt, it doesn't act on the
// distinction itself (delete-vs-void semantics are implemented in `qbo/inbound-sync.ts`, 20009).
export const webhookBodySchema = {
  type: 'object',
  required: ['eventNotifications'],
  properties: {
    eventNotifications: {
      type: 'array',
      items: {
        type: 'object',
        required: ['realmId', 'dataChangeEvent'],
        properties: {
          realmId: { type: 'string', minLength: 1 },
          dataChangeEvent: {
            type: 'object',
            required: ['entities'],
            properties: {
              entities: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'id', 'operation'],
                  properties: {
                    name: { type: 'string' },
                    id: { type: 'string' },
                    operation: {
                      type: 'string',
                      enum: ['Create', 'Update', 'Delete', 'Merge', 'Void', 'Emailed'],
                    },
                    lastUpdated: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** Flattens QBO's nested `eventNotifications[].dataChangeEvent.entities[]` shape into one entry
 * per realm, used by the route and directly testable on its own. */
export function parseWebhookNotifications(body: WebhookBody): WebhookEventNotification[] {
  return body.eventNotifications.map((notification) => ({
    realmId: notification.realmId,
    entities: notification.dataChangeEvent.entities,
  }));
}
