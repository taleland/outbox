import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreate, createProcessOutbox, type OutboxMessage, type OutboxStorage } from '@taleland/outbox-core';
import { createNodeTsPublish, type GetNodeTsBus, type NodeTsOutboxMetadata } from '../src/index.js';

const metadata = { busToken: 'events', eventName: 'orders/created', eventVersion: 1 } satisfies NodeTsOutboxMetadata;
const context = { metadata, outboxId: 'stable-id' };

test('resolves each named bus lazily and maps persisted metadata to node-ts events', async () => {
  const calls: unknown[] = [];
  const resolved: string[] = [];
  const getBus: GetNodeTsBus = token => {
    resolved.push(token);
    return { async publish (event, attributes) { calls.push({ token, event, attributes }); } };
  };
  const publish = createNodeTsPublish(getBus);
  assert.deepEqual(calls, []);
  assert.deepEqual(resolved, []);
  await publish({ orderId: 42 }, context);
  await publish({ customerId: 7 }, {
    ...context, metadata: { busToken: 'customers', eventName: 'customers/created', eventVersion: 0 },
  });
  assert.deepEqual(resolved, ['events', 'customers']);
  assert.deepEqual(calls, [
    { token: 'events', event: { orderId: 42, $name: 'orders/created', $version: 1 }, attributes: { attributes: { outboxId: 'stable-id' } } },
    { token: 'customers', event: { customerId: 7, $name: 'customers/created', $version: 0 }, attributes: { attributes: { outboxId: 'stable-id' } } },
  ]);
});

test('adapter metadata controls protocol fields without mutating the supplied payload', async () => {
  const payload = Object.freeze({ $name: 'old', $version: 99, orderId: 42 });
  const publish = createNodeTsPublish(() => ({
    async publish (event, attributes) {
      assert.deepEqual(event, { $name: 'orders/created', $version: 1, orderId: 42 });
      assert.deepEqual(attributes, { attributes: { outboxId: 'stable-id' } });
      assert.notEqual(event, payload);
    }
  }));
  await publish(payload, { ...context, metadata: Object.freeze({ ...metadata, privateRoutingHint: 'not forwarded', outboxId: 'spoofed' }) });
  assert.deepEqual(payload, { $name: 'old', $version: 99, orderId: 42 });
});

test('rejects missing or invalid routing metadata before resolving a bus', async () => {
  const publish = createNodeTsPublish(() => { assert.fail('Invalid metadata must not reach the bus'); });
  const cases: [string, unknown[]][] = [
    ['busToken', [undefined, null, '', '   ', 3, {}, []]],
    ['eventName', [undefined, null, '', '\n', 3, {}, []]],
    ['eventVersion', [undefined, null, '1', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]],
  ];
  await assert.rejects(publish({}, { ...context, metadata: {} }), /metadata.busToken/);
  for (const [field, invalidValues] of cases) {
    for (const value of invalidValues) {
      await assert.rejects(publish({}, { ...context, metadata: { ...metadata, [field]: value } }),
        error => error instanceof TypeError && error.message.includes(`metadata.${field}`));
    }
  }
});

test('waits for the bus publication promise before resolving', async () => {
  const pending = Promise.withResolvers<void>();
  let completed = false;
  const publish = createNodeTsPublish(() => ({ publish: async () => await pending.promise }));
  const result = publish({}, context).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  pending.resolve();
  await result;
  assert.equal(completed, true);
});

test('propagates bus resolution and publication failures unchanged', async () => {
  const failure = new Error('bus unavailable');
  const missing = createNodeTsPublish(() => { throw failure; });
  await assert.rejects(missing({}, context), error => error === failure);
  const rejected = createNodeTsPublish(() => ({ publish: async () => { throw failure; } }));
  await assert.rejects(rejected({}, context), error => error === failure);
});

test('core retries retain the event routing and outbox ID after a failed bus publication', async () => {
  let record!: OutboxMessage;
  let now = new Date('2026-01-01T00:00:00Z');
  const store: OutboxStorage<undefined> = {
    transaction: async work => await work(undefined),
    insert: async rows => { [record] = rows; },
    withBatch: async (query, work) => {
      assert.ok(record.nextAttemptAt <= query.now);
      await work({ messages: [record], save: async () => {} });
    },
    cleanDelivered: async () => 0,
  };
  await createCreate(store, { uuid: () => 'stable-id', now: () => now })([{
    payload: { order: { id: 42 } }, metadata,
  }], undefined);
  const attempts: unknown[] = [];
  const publish = createNodeTsPublish(token => ({
    async publish (event, attributes) {
      attempts.push(structuredClone({ token, event, attributes }));
      if (attempts.length === 1) {
        Object.assign(event, { $name: 'changed', order: { id: 99 } });
        throw new Error('transport unavailable');
      }
    }
  }));
  const process = createProcessOutbox(store, publish, { now: () => now });
  await process();
  assert.equal(record.state, 'FAILED');
  assert.deepEqual(record.payload, { order: { id: 42 } });
  now = new Date(now.getTime() + 5000);
  await process();
  assert.equal(record.state, 'DELIVERED');
  assert.equal(record.retries, 1);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[1], {
    token: 'events',
    event: { order: { id: 42 }, $name: 'orders/created', $version: 1 },
    attributes: { attributes: { outboxId: 'stable-id' } },
  });
});
