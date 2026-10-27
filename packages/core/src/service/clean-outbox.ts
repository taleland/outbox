import { type OutboxStorage } from '../contracts.js';
import { positiveInteger } from './validation.js';

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
