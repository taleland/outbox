import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCreate, createWithOutbox, createProcessOutbox, createCleanOutbox,
  OutboxMessage, type OutboxStorage, type OutboxEvent, type OutboxState,
} from '../src/index.js';

const unexpected = async (): Promise<never> => { throw new Error('Unexpected storage call'); };
const transaction = { id: 'transaction' };
const storage = (overrides: Partial<OutboxStorage<typeof transaction>> = {}): OutboxStorage<typeof transaction> => ({
  transaction: unexpected, insert: unexpected, withBatch: unexpected, cleanDelivered: unexpected, ...overrides,
});
const event = { $name: 'orders/placed', $version: 1, $queueName: 'orders', details: { total: 42 } };
const timestamp = new Date('2026-01-01T00:00:00Z');

async function message (): Promise<OutboxMessage> {
  let record!: OutboxMessage;
  await createCreate(storage({ insert: async rows => { [record] = rows; } }), {
    uuid: () => 'stable-id', now: () => timestamp,
  })([event], transaction);
  return record;
}

test('creation snapshots the payload and validates the whole batch before storage', async () => {
  let writes = 0;
  let records: readonly OutboxMessage[] = [];
  const create = createCreate(storage({
    insert: async (rows, tx) => {
      assert.equal(tx, transaction); writes++; records = rows;
    }
  }), { uuid: () => 'stable-id', now: () => timestamp });
  const source = structuredClone(event);
  await create([source], transaction);
  source.details.total = 99;
  assert.deepEqual(records[0].body, { details: { total: 42 } });
  assert.equal(records[0].queueName, 'orders');
  assert.equal(records[0].id, 'stable-id');
  assert.equal(records[0].nextAttemptAt, timestamp);
  await assert.rejects(create([event, { ...event, $queueName: ' ' }], transaction), /missing/);
  await assert.rejects(create([{ ...event, $version: 0.5 }], transaction), /version/);
  await assert.rejects(create([{ ...event, $name: '' }], transaction), /name/);
  await create([], transaction);
  assert.equal(writes, 1);
});

test('unit of work inserts all events in the supplied transaction after successful work', async () => {
  const calls: string[] = [];
  let lateEmit!: (event: OutboxEvent) => void;
  const withOutbox = createWithOutbox(storage({
    transaction: async work => {
      calls.push('begin'); const result = await work(transaction); calls.push('commit'); return result;
    },
    insert: async (rows, tx) => { assert.equal(tx, transaction); assert.equal(rows.length, 2); calls.push('insert'); },
  }));
  assert.equal(await withOutbox(async ({ transaction: tx, emit }) => {
    assert.equal(tx, transaction); calls.push('work'); emit(event); emit(event); lateEmit = emit; return 42;
  }), 42);
  assert.deepEqual(calls, ['begin', 'work', 'insert', 'commit']);
  assert.throws(() => lateEmit(event), /finished/);
});

test('unit of work propagates callback and commit failures, including undefined rejection', async () => {
  const withOutbox = createWithOutbox(storage({ transaction: async work => await work(transaction) }));
  await assert.rejects(withOutbox(async ({ emit }) => { emit(event); throw new Error('work failed'); }), /work failed/);
  // A callback can reject without an Error; the transaction must still reject.
  // eslint-disable-next-line prefer-promise-reject-errors
  await assert.rejects(withOutbox(async () => await Promise.reject(undefined)), error => error === undefined);
  const commitError = new Error('commit failed');
  const failingCommit = createWithOutbox(storage({
    transaction: async work => { await work(transaction); throw commitError; },
  }));
  await assert.rejects(failingCommit(async () => 1), error => error === commitError);
});

test('one emit call accepts different event classes without index signatures', async () => {
  class FirstEvent {
    $name = 'first'; $version = 1; $queueName = 'events'; first = 42;
  }
  class SecondEvent {
    $name = 'second'; $version = 1; $queueName = 'events'; second = true;
  }
  const rows: OutboxMessage[] = [];
  const store = storage({
    transaction: async work => await work(transaction),
    insert: async messages => { rows.push(...messages); },
  });
  await createWithOutbox(store)(async ({ emit }) => { emit(new FirstEvent(), new SecondEvent()); });
  assert.deepEqual(rows.map(row => row.body), [{ first: 42 }, { second: true }]);
});

test('state transitions count retries, reject illegal transitions, and preserve identity', async () => {
  const record = await message();
  assert.throws(() => record.delivery(), /state conflict/);
  record.process(); assert.equal(record.retries, 0);
  record.fail(); record.process(); assert.equal(record.retries, 1);
  record.delivery();
  assert.equal(record.id, 'stable-id');
  assert.throws(() => record.process(), /state conflict/);
  assert.throws(() => record.fail(), /state conflict/);
});

test('publisher failures schedule a retry and successful publication uses stable metadata', async () => {
  const record = await message();
  const states: OutboxState[] = [];
  const store = storage({
    withBatch: async (query, work) => {
      assert.deepEqual(query, { now: timestamp, limit: 100, maxRetries: 3 });
      await work({ messages: [record], save: async row => { states.push(row.state); } });
    }
  });
  // eslint-disable-next-line no-throw-literal -- Even an empty rejection must schedule a retry.
  await createProcessOutbox(store, async () => { throw undefined; }, { now: () => timestamp })();
  assert.equal(record.state, 'FAILED');
  assert.equal(record.nextAttemptAt.getTime(), timestamp.getTime() + 5000);
  await createProcessOutbox(store, async (payload, context) => {
    assert.deepEqual(context, { queueName: 'orders', outboxId: 'stable-id' });
    assert.deepEqual(payload, { details: { total: 42 }, $name: 'orders/placed', $version: 1 });
  }, { now: () => timestamp })();
  assert.deepEqual(states, ['PROCESSED', 'FAILED', 'PROCESSED', 'DELIVERED']);
  assert.equal(record.retries, 1);
});

test('persistence failures escape to the storage transaction instead of becoming publish failures', async () => {
  const record = await message();
  let published = false;
  const store = storage({
    withBatch: async (_, work) => await work({
      messages: [record], save: async () => { throw new Error('database failed'); },
    })
  });
  await assert.rejects(createProcessOutbox(store, async () => { published = true; })(), /database failed/);
  assert.equal(published, false);
});

test('cleanup uses the configured cutoff and validates processing limits', async () => {
  const store = storage({
    cleanDelivered: async (before, deletedAt) => {
      assert.equal(deletedAt, timestamp);
      assert.equal(before.getTime(), timestamp.getTime() - 1000);
      return 2;
    }
  });
  assert.equal(await createCleanOutbox(store, { now: () => timestamp, retentionMs: 1000 })(), 2);
  assert.throws(() => createCleanOutbox(store, { retentionMs: 0 }), /retentionMs/);
  for (const options of [{ batchSize: 0 }, { retryDelayMs: -1 }, { maxRetries: -1 }]) {
    assert.throws(() => createProcessOutbox(store, async () => {}, options), RangeError);
  }
});
