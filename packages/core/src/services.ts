import { randomUUID } from 'node:crypto';
import { OutboxMessage } from './message.js';
import {
  type Create, type OutboxEvent, type OutboxLogger,
  type OutboxStorage, type Publish, type WithOutbox,
} from './contracts.js';

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

export function createWithOutbox<Transaction> (
  storage: OutboxStorage<Transaction>, create: Create<Transaction> = createCreate(storage)
): WithOutbox<Transaction> {
  return async work => await storage.transaction(async transaction => {
    const events: OutboxEvent[] = [];
    let accepting = true;
    try {
      const result = await work({
        transaction,
        emit: (...batch) => {
          if (!accepting) throw new Error('Outbox unit of work has finished');
          events.push(...batch);
        },
      });
      accepting = false;
      await create(events, transaction);
      return result;
    } finally {
      accepting = false;
    }
  });
}

export interface ProcessOutboxOptions {
  batchSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  now?: () => Date;
  logger?: OutboxLogger;
}

function positiveInteger (value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Outbox ${name} must be a positive safe integer`);
}

export function createProcessOutbox<Transaction> (
  storage: OutboxStorage<Transaction>, publish: Publish, options: ProcessOutboxOptions = {}
): () => Promise<void> {
  const batchSize = options.batchSize ?? 100;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const now = options.now ?? (() => new Date());
  positiveInteger(batchSize, 'batchSize');
  positiveInteger(retryDelayMs, 'retryDelayMs');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new RangeError('Outbox maxRetries must be a nonnegative safe integer');
  return async () => await storage.withBatch({ now: now(), limit: batchSize, maxRetries }, async batch => {
    for (const message of batch.messages) {
      message.process();
      await batch.save(message);
      try {
        await publish({ ...message.body, $name: message.name, $version: message.version }, {
          queueName: message.queueName, outboxId: message.id,
        });
      } catch (error) {
        message.fail();
        message.updatedAt = now();
        message.nextAttemptAt = new Date(message.updatedAt.getTime() + retryDelayMs);
        if (message.retries >= maxRetries) options.logger?.warn(`Outbox message retries exhausted: ${message.id}`);
        options.logger?.error(`Outbox publication failed: ${message.id}`, error);
        await batch.save(message);
        continue;
      }
      message.delivery();
      message.updatedAt = now();
      await batch.save(message);
    }
  });
}

export interface CleanOutboxOptions {
  now?: () => Date;
  retentionMs?: number;
}

export function createCleanOutbox<Transaction> (
  storage: OutboxStorage<Transaction>, options: CleanOutboxOptions = {}
): () => Promise<number> {
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  positiveInteger(retentionMs, 'retentionMs');
  return async () => {
    const timestamp = now();
    return await storage.cleanDelivered(new Date(timestamp.getTime() - retentionMs), timestamp);
  };
}
