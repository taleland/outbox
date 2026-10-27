import { LockMode, TransactionPropagation } from '@mikro-orm/core';
import { type EntityManager } from '@mikro-orm/postgresql';
import { type BatchQuery, type OutboxBatch, OutboxMessage, type OutboxStorage } from '@taleland/outbox-core';

export class MikroOrmOutboxStorage implements OutboxStorage<EntityManager> {
  constructor (private readonly entityManager: EntityManager) {}

  async transaction<Result> (work: (transaction: EntityManager) => Promise<Result>): Promise<Result> {
    const isolated = this.entityManager.fork({ clear: true, useContext: false });
    return await isolated.transactional(work, { propagation: TransactionPropagation.REQUIRES_NEW });
  }

  async insert (messages: readonly OutboxMessage[], transaction: EntityManager): Promise<void> {
    if (messages.length === 0) return;
    if (!transaction.isInTransaction()) throw new Error('Outbox creation requires an active transaction');
    transaction.persist([...messages]);
    await transaction.flush();
  }

  async withBatch (query: BatchQuery, work: (batch: OutboxBatch) => Promise<void>): Promise<void> {
    await this.transaction(async transaction => {
      const messages = await transaction.find(OutboxMessage, {
        $or: [{ state: 'PENDING' }, { state: 'FAILED', retries: { $lt: query.maxRetries } }],
        deletedAt: null,
        nextAttemptAt: { $lte: query.now },
      }, {
        limit: query.limit,
        orderBy: { createdAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      await work({
        messages,
        save: async message => { transaction.persist(message); await transaction.flush(); },
      });
    });
  }

  async cleanDelivered (createdBefore: Date, deletedAt: Date): Promise<number> {
    const isolated = this.entityManager.fork({ clear: true, useContext: false });
    return await isolated.nativeUpdate(OutboxMessage, {
      state: 'DELIVERED', deletedAt: null, createdAt: { $lt: createdBefore },
    }, { deletedAt, updatedAt: deletedAt });
  }
}
