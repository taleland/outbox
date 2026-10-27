import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { EntitySchema, type MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { MikroORM, type PostgreSqlDriver } from '@mikro-orm/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { createCreate, createWithOutbox, createProcessOutbox, createCleanOutbox, OutboxMessage } from '@taleland/outbox';
import { MikroOrmOutboxStorage, OutboxSchema } from '../../src/index.js';

class Order {
  id!: string;
  total!: number;
}
const OrderSchema = new EntitySchema<Order>({
  class: Order,
  properties: { id: { type: 'uuid', primary: true }, total: { type: 'integer' } },
});
const event = (orderId = randomUUID()) => ({
  $name: 'orders/placed', $version: 1, $queueName: 'orders', orderId,
});

describe('MikroORM PostgreSQL strategy', { timeout: 120000 }, () => {
  let container: StartedTestContainer;
  let orm: CoreMikroORM<PostgreSqlDriver>;
  let store: MikroOrmOutboxStorage;
  before(async () => {
    container = await new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_USER: 'outbox', POSTGRES_PASSWORD: 'outbox', POSTGRES_DB: 'outbox' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    orm = await MikroORM.init({
      entities: [OrderSchema, OutboxSchema],
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'outbox',
      password: 'outbox',
      dbName: 'outbox',
      pool: { min: 0, max: 8 },
    });
    await orm.schema.create();
    store = new MikroOrmOutboxStorage(orm.em);
  });
  after(async () => {
    try { await orm?.close(true); } finally { await container?.stop(); }
  });
  beforeEach(async () => {
    const em = orm.em.fork();
    await em.nativeDelete(OutboxMessage, {});
    await em.nativeDelete(Order, {});
  });

  test('business data and events commit together, with callback and event errors rolling back both', async () => {
    const withOutbox = createWithOutbox(store);
    const id = randomUUID();
    assert.equal(await withOutbox(async ({ transaction, emit }) => {
      transaction.persist(transaction.create(Order, { id, total: 42 }));
      emit(event(id));
      return id;
    }), id);
    assert.equal(await orm.em.fork().count(Order), 1);
    const [saved] = await orm.em.fork().findAll(OutboxMessage);
    assert.equal(saved.body.orderId, id);
    assert.equal(saved.state, 'PENDING');

    await assert.rejects(withOutbox(async ({ transaction, emit }) => {
      transaction.persist(transaction.create(Order, { id: randomUUID(), total: 99 }));
      emit(event());
      await transaction.flush();
      throw new Error('application failure');
    }), /application failure/);
    await assert.rejects(withOutbox(async ({ transaction, emit }) => {
      transaction.persist(transaction.create(Order, { id: randomUUID(), total: 99 }));
      await transaction.flush();
      emit({ ...event(), $queueName: '' });
    }), /missing/);
    assert.equal(await orm.em.fork().count(Order), 1);
    assert.equal(await orm.em.fork().count(OutboxMessage), 1);
  });

  test('direct creation requires a transaction and joins the caller-owned transaction', async () => {
    const create = createCreate(store);
    await assert.rejects(create([event()], orm.em.fork()), /active transaction/);
    await create([], orm.em.fork());
    await assert.rejects(orm.em.fork().transactional(async em => {
      await create([event()], em);
      throw new Error('outer rollback');
    }), /outer rollback/);
    assert.equal(await orm.em.fork().count(OutboxMessage), 0);
  });

  test('an outbox database constraint failure rolls back already flushed business changes', async () => {
    const id = randomUUID();
    const create = createCreate(store, { uuid: () => id });
    await store.transaction(async tx => { await create([event()], tx); });
    await assert.rejects(createWithOutbox(store, create)(async ({ transaction, emit }) => {
      transaction.persist(transaction.create(Order, { id: randomUUID(), total: 42 }));
      await transaction.flush();
      emit(event());
    }), /duplicate key/);
    assert.equal(await orm.em.fork().count(Order), 0);
    assert.equal(await orm.em.fork().count(OutboxMessage), 1);
  });

  test('storage-owned units of work do not join an ambient transaction', async () => {
    await assert.rejects(orm.em.fork().transactional(async () => {
      await createWithOutbox(store)(async ({ emit }) => { emit(event()); });
      throw new Error('ambient rollback');
    }), /ambient rollback/);
    assert.equal(await orm.em.fork().count(OutboxMessage), 1);
  });

  test('SKIP LOCKED distributes rows between overlapping workers', { timeout: 15000 }, async () => {
    await createWithOutbox(store)(async ({ emit }) => { emit(event(), event()); });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ids: string[] = [];
    const first = createProcessOutbox(store, async (_, context) => {
      ids.push(context.outboxId); entered.resolve(); await release.promise;
    }, { batchSize: 1 })();
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('First worker unexpectedly finished'); })]);
      const second = createProcessOutbox(store, async (_, context) => { ids.push(context.outboxId); }, { batchSize: 1 });
      await second();
      await second();
      assert.equal(ids.length, 2);
      assert.equal(new Set(ids).size, 2);
    } finally {
      release.resolve();
      await first;
    }
    assert.equal(await orm.em.fork().count(OutboxMessage, { state: 'DELIVERED' }), 2);
  });

  test('rollback after a flushed PROCESSED state makes the message eligible again', async () => {
    await createWithOutbox(store)(async ({ emit }) => { emit(event()); });
    await assert.rejects(store.withBatch({ now: new Date(), limit: 1, maxRetries: 3 }, async batch => {
      batch.messages[0].process();
      await batch.save(batch.messages[0]);
      throw new Error('worker crashed');
    }), /worker crashed/);
    const [record] = await orm.em.fork().findAll(OutboxMessage);
    assert.equal(record.state, 'PENDING');
    await createProcessOutbox(store, async () => {})();
    assert.equal(await orm.em.fork().count(OutboxMessage, { state: 'DELIVERED' }), 1);
  });

  test('retry eligibility respects time and stops after four total attempts', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const create = createCreate(store, { now: () => clock });
    await store.transaction(async tx => { await create([event()], tx); });
    const ids: string[] = [];
    const process = createProcessOutbox(store, async (_, context) => {
      ids.push(context.outboxId); throw new Error('broker unavailable');
    }, { now: () => clock });
    await process();
    await process();
    assert.equal(ids.length, 1);
    for (let retry = 1; retry <= 4; retry++) {
      clock = new Date(clock.getTime() + 5000);
      await process();
    }
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 1);
    const [failed] = await orm.em.fork().findAll(OutboxMessage);
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.retries, 3);
  });

  test('cleanup soft-deletes only old delivered rows and leaves other states eligible', async () => {
    const clock = new Date('2026-02-01T00:00:00Z');
    const old = new Date(clock.getTime() - 8 * 24 * 3600000);
    await store.transaction(async tx => {
      await createCreate(store, { now: () => old })([event(), event(), event()], tx);
      await createCreate(store, { now: () => clock })([event()], tx);
    });
    const em = orm.em.fork();
    const records = await em.findAll(OutboxMessage, { orderBy: { createdAt: 'asc', id: 'asc' } });
    records[0].state = 'DELIVERED';
    records[1].state = 'FAILED';
    records[3].state = 'DELIVERED';
    await em.flush();
    assert.equal(await createCleanOutbox(store, { now: () => clock })(), 1);
    const fresh = orm.em.fork();
    assert.equal(await fresh.count(OutboxMessage, { deletedAt: { $ne: null } }), 1);
    assert.equal(await fresh.count(OutboxMessage, { state: 'FAILED', deletedAt: null }), 1);
    assert.equal(await fresh.count(OutboxMessage, { state: 'PENDING', deletedAt: null }), 1);
    assert.equal(await fresh.count(OutboxMessage), 4);
  });
});
