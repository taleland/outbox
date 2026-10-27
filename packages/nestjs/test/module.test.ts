import 'reflect-metadata';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { type OutboxMessage, type OutboxStorage, type Publish, type WithOutbox } from '@taleland/outbox-core';
import { OutboxModule, OutboxService, OUTBOX_SYMBOLS, type OutboxModuleOptions } from '../src/index.js';

type Transaction = { id: string };
const transaction: Transaction = { id: 'test-transaction' };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected storage call'); };
const storage = (overrides: Partial<OutboxStorage<Transaction>> = {}): OutboxStorage<Transaction> => ({
  transaction: unexpected, insert: unexpected, withBatch: unexpected, cleanDelivered: unexpected, ...overrides,
});
const publish: Publish = async () => {};
const futureCron = '0 0 1 1 *';

@Injectable()
class Consumer {
  constructor (
    readonly outbox: OutboxService<Transaction>,
    @Inject(OUTBOX_SYMBOLS.withOutbox) readonly withOutbox: WithOutbox<Transaction>
  ) {}
}

@Module({})
class FeatureModule {}

test('register exports the facade and individual services into an importing Nest module', async () => {
  const records: OutboxMessage[] = [];
  const calls: string[] = [];
  const now = new Date('2026-01-01T00:00:00Z');
  const adapter = storage({
    transaction: async work => { calls.push('begin'); const result = await work(transaction); calls.push('commit'); return result; },
    insert: async (rows, tx) => { assert.equal(tx, transaction); records.push(...rows); calls.push('insert'); },
    withBatch: async (query, work) => {
      assert.deepEqual(query, { now, limit: 5, maxRetries: 2 });
      await work({ messages: records, save: async () => {} });
    },
    cleanDelivered: async (cutoff, timestamp) => {
      assert.equal(timestamp, now); assert.equal(cutoff.getTime(), now.getTime() - 1000); return 7;
    },
  });
  const module = await Test.createTestingModule({
    imports: [{
      module: FeatureModule,
      imports: [OutboxModule.register({
        storage: adapter,
        publish: async (payload, context) => {
          assert.deepEqual(payload, { orderId: 42 });
          assert.deepEqual(context, { metadata: {}, outboxId: 'stable-id' });
        },
        create: { uuid: () => 'stable-id', now: () => now },
        process: { batchSize: 5, maxRetries: 2, now: () => now },
        clean: { retentionMs: 1000, now: () => now },
      })],
      providers: [Consumer],
    }],
  }).compile();
  try {
    await module.init();
    const consumer = module.get(Consumer);
    assert.equal(consumer.outbox.withOutbox, consumer.withOutbox);
    assert.equal(consumer.outbox.create, module.get(OUTBOX_SYMBOLS.create));
    assert.equal(consumer.outbox.processOutbox, module.get(OUTBOX_SYMBOLS.processOutbox));
    assert.equal(consumer.outbox.cleanOutbox, module.get(OUTBOX_SYMBOLS.cleanOutbox));
    const result = await consumer.withOutbox(async ({ transaction: tx, emit }) => {
      assert.equal(tx, transaction); calls.push('work'); emit({ payload: { orderId: 42 } }); return 'result';
    });
    assert.equal(result, 'result');
    assert.deepEqual(calls, ['begin', 'work', 'insert', 'commit']);
    await consumer.outbox.processOutbox();
    assert.equal(records[0].state, 'DELIVERED');
    assert.equal(await consumer.outbox.cleanOutbox(), 7);
    assert.throws(() => module.get(SchedulerRegistry), /SchedulerRegistry/);
  } finally { await module.close(); }
});

test('registerAsync resolves imported dependencies and supports explicit global registration', async () => {
  const adapter = storage({ transaction: async work => await work(transaction), insert: async () => {} });
  const adapterToken = Symbol('adapter');
  @Module({ providers: [{ provide: adapterToken, useValue: adapter }], exports: [adapterToken] })
  class DatabaseModule {}
  const module = await Test.createTestingModule({
    imports: [
      OutboxModule.registerAsync({
        global: true,
        imports: [DatabaseModule],
        inject: [adapterToken],
        useFactory: async (resolved: OutboxStorage<Transaction>) => ({ storage: resolved, publish, jobs: false }),
      }),
      { module: FeatureModule, providers: [Consumer] },
    ],
  }).compile();
  try {
    await module.init();
    assert.equal(await module.get(Consumer).withOutbox(async ({ transaction: tx }) => tx.id), transaction.id);
    assert.throws(() => module.get(SchedulerRegistry), /SchedulerRegistry/);
  } finally { await module.close(); }
});

test('async configuration failures reject startup instead of falling back to an unconfigured module', async () => {
  await assert.rejects(Test.createTestingModule({
    imports: [OutboxModule.registerAsync({ useFactory: async () => { throw new Error('configuration unavailable'); } })],
  }).compile(), /configuration unavailable/);
});

test('enabling jobs without the application scheduler fails with an actionable error', async () => {
  const module = await Test.createTestingModule({
    imports: [OutboxModule.register({ storage: storage(), publish, jobs: {} })],
  }).compile();
  try {
    await assert.rejects(module.init(), /ScheduleModule.forRoot/);
  } finally { await module.close(); }
});

test('enabling jobs registers the default schedules and removes them on close', async () => {
  const adapter = storage({ withBatch: async () => {}, cleanDelivered: async () => 0 });
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot(), OutboxModule.register({ storage: adapter, publish, jobs: {} })],
  }).compile();
  const registry = module.get(SchedulerRegistry);
  assert.equal(registry.getCronJobs().size, 0);
  try {
    await module.init();
    const process = registry.getCronJob('outbox.process');
    const clean = registry.getCronJob('outbox.clean');
    assert.equal(process.cronTime.source, '* * * * * *');
    assert.equal(clean.cronTime.source, '0 0 0 * * *');
    assert.equal(clean.cronTime.timeZone, 'UTC');
    assert.equal(process.waitForCompletion, true);
    assert.equal(clean.waitForCompletion, true);
    assert.equal(process.isActive, true);
    assert.equal(clean.isActive, true);
  } finally { await module.close(); }
  assert.equal(registry.getCronJobs().size, 0);
});

test('a scheduled batch does not overlap and application shutdown waits for it to finish', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const adapter = storage({ withBatch: async () => { calls++; entered.resolve(); await release.promise; } });
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot(), OutboxModule.register({ storage: adapter, publish, jobs: { process: { cron: futureCron }, clean: false } })],
  }).compile();
  await module.init();
  const registry = module.get(SchedulerRegistry);
  assert.equal(registry.getCronJobs().size, 1);
  const job = registry.getCronJob('outbox.process');
  const running = job.fireOnTick();
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    await job.fireOnTick();
    assert.equal(calls, 1);
    closing = module.close().then(() => { closed = true; });
    await setImmediate();
    assert.equal(closed, false);
    assert.equal(job.isActive, false);
  } finally {
    release.resolve();
    await running;
    await (closing ?? module.close());
  }
  assert.equal(closed, true);
  assert.equal(registry.getCronJobs().size, 0);
  await job.fireOnTick();
  assert.equal(calls, 1);
});

test('a failed scheduled batch is logged and does not prevent the next run', async context => {
  const errors: string[] = [];
  context.mock.method(Logger.prototype, 'error', (message: unknown) => { errors.push(String(message)); });
  let calls = 0;
  const adapter = storage({ withBatch: async () => { if (++calls === 1) throw new Error('database temporarily unavailable'); } });
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot(), OutboxModule.register({ storage: adapter, publish, jobs: { process: { cron: futureCron }, clean: false } })],
  }).compile();
  try {
    await module.init();
    const job = module.get(SchedulerRegistry).getCronJob('outbox.process');
    await job.fireOnTick();
    await job.fireOnTick();
    assert.equal(calls, 2);
    assert.deepEqual(errors, ['Scheduled outbox.process failed']);
    assert.equal(job.isActive, true);
  } finally { await module.close(); }
});

test('cleanup can be scheduled independently and forwards retention options', async () => {
  let calls = 0;
  const now = new Date('2026-01-01T00:00:00Z');
  const adapter = storage({
    cleanDelivered: async (cutoff, at) => {
      calls++; assert.equal(at, now); assert.equal(cutoff.getTime(), now.getTime() - 5000); return 3;
    }
  });
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot(), OutboxModule.register({
      storage: adapter,
      publish,
      clean: { retentionMs: 5000, now: () => now },
      jobs: { process: false, clean: { cron: futureCron, timeZone: 'Europe/London' } },
    })],
  }).compile();
  try {
    await module.init();
    const registry = module.get(SchedulerRegistry);
    assert.equal(registry.doesExist('cron', 'outbox.process'), false);
    const job = registry.getCronJob('outbox.clean');
    assert.equal(job.cronTime.timeZone, 'Europe/London');
    await job.fireOnTick();
    assert.equal(calls, 1);
  } finally { await module.close(); }
});

test('invalid schedules fail startup without starting another job', async () => {
  const options: OutboxModuleOptions<Transaction> = {
    storage: storage(), publish, jobs: { process: { cron: futureCron }, clean: { cron: 'invalid cron' } },
  };
  const module = await Test.createTestingModule({ imports: [ScheduleModule.forRoot(), OutboxModule.register(options)] }).compile();
  try {
    await assert.rejects(module.init(), /Unknown alias|Too few fields|Invalid/);
    assert.equal(module.get(SchedulerRegistry).getCronJobs().size, 0);
  } finally { await module.close(); }
});
