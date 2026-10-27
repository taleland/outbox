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
      const { $name, $version, $queueName, ...body } = event;
      if (typeof $name !== 'string' || !$name.trim()) throw new TypeError('Event $name must be a nonempty string');
      if (!Number.isSafeInteger($version) || $version < 0) throw new TypeError('Event $version must be a nonnegative integer');
      if (typeof $queueName !== 'string' || !$queueName.trim()) throw new TypeError(`Event ${$name} is missing $queueName`);
      const message = new OutboxMessage();
      const timestamp = now();
      Object.assign(message, {
        id: uuid(),
        name: $name,
        version: $version,
        queueName: $queueName,
        body: structuredClone(body),
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
