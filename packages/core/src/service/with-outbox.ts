import { type Create, type OutboxEvent, type OutboxStorage, type WithOutbox } from '../contracts.js';
import { createCreate } from './create.js';

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
