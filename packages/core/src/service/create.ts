import { randomUUID } from 'node:crypto';
import { OutboxMessage } from '../message.js';
import { type Create, type OutboxLogger, type OutboxStorage } from '../contracts.js';

export interface CreateOptions {
  now?: () => Date;
  uuid?: () => string;
  logger?: OutboxLogger;
}

export function createCreate<Transaction> (
  storage: OutboxStorage<Transaction>, options: CreateOptions = {}
): Create<Transaction> {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  return async (events, transaction) => {
    if (events.length === 0) return;
    const messages = events.map(event => {
      const { payload, metadata = {} } = event;
      for (const [name, value] of [['payload', payload], ['metadata', metadata]]) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError(`Outbox ${name} must be an object`);
        }
      }
      const message = new OutboxMessage();
      const timestamp = now();
      Object.assign(message, {
        id: uuid(),
        payload: structuredClone(payload),
        metadata: structuredClone(metadata),
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
      });
      return message;
    });
    await storage.insert(messages, transaction);
    options.logger?.debug(`Created ${messages.length} outbox messages`);
  };
}
