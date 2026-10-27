import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessage } from '@taleland/outbox-core';

export const OutboxSchema = new EntitySchema<OutboxMessage>({
  class: OutboxMessage,
  tableName: 'outbox',
  indexes: [{ name: 'outbox_pending_idx', properties: ['state', 'nextAttemptAt', 'createdAt'] }],
  properties: {
    id: { type: 'uuid', primary: true },
    state: { type: 'string', default: 'PENDING' },
    retries: { type: 'integer', default: 0 },
    payload: { type: 'json', columnType: 'jsonb' },
    metadata: { type: 'json', columnType: 'jsonb' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    deletedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});
