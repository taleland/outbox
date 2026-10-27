import { type OutboxLogger, type OutboxStorage, type Publish } from '../contracts.js';
import { positiveInteger } from './validation.js';

export interface ProcessOutboxOptions {
  batchSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  now?: () => Date;
  logger?: OutboxLogger;
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
