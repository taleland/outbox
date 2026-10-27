import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessage } from '@taleland/outbox';

export const OutboxSchema = new EntitySchema<OutboxMessage>({
  class: OutboxMessage,
  tableName: 'outbox',
  indexes: [{ name: 'outbox_pending_idx', properties: ['state', 'nextAttemptAt', 'createdAt'] }],
  properties: {
    id: { type: 'uuid', primary: true },
    name: { type: 'string' },
    queueName: { type: 'string' },
    version: { type: 'integer' },
    state: { type: 'string', default: 'PENDING' },
    retries: { type: 'integer', default: 0 },
    body: { type: 'json', columnType: 'jsonb' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    deletedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});
