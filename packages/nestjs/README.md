# @taleland/outbox-nestjs

NestJS integration for `@taleland/outbox-core`: an `OutboxModule`, injectable services, and optional scheduled processing and cleanup. The module accepts any `OutboxStorage<Transaction>` and `Publish` implementation. It has no dependency on MikroORM or a broker SDK.

**Unreleased:** this package is part of [taleland/outbox](https://github.com/taleland/outbox). Publishing remains disabled while the packages are being reviewed.

## Install

After the first release, install in a NestJS 12 application:

```sh
pnpm add @taleland/outbox-nestjs @taleland/outbox-core @nestjs/schedule@^12.0.2
```

Use Node.js 22.17+, matching NestJS 12 versions of `@nestjs/common` and `@nestjs/core`, `reflect-metadata` 0.2, and RxJS 7.8. The scheduling peer must be installed even when jobs are disabled; initialize `ScheduleModule.forRoot()` only if you enable jobs. The core package remains independent of NestJS and scheduling libraries.

## Register an existing storage and publisher

```ts
import { OutboxModule } from '@taleland/outbox-nestjs';
import type { OutboxStorage, Publish } from '@taleland/outbox-core';

export function configureOutbox<Transaction>(storage: OutboxStorage<Transaction>, publish: Publish) {
  return OutboxModule.register({
    storage,
    publish,
    process: { batchSize: 100, maxRetries: 3, retryDelayMs: 5000 },
    clean: { retentionMs: 7 * 24 * 60 * 60 * 1000 },
    jobs: false, // The default. No timers are started.
  });
}
```

Import the returned dynamic module in the Nest module that needs outbox services. Set `global: true` to make the services available to all modules, or re-export `OutboxModule` through a shared application module. Register one configured outbox module per application.

## Complete MikroORM example

The following uses PostgreSQL as one possible strategy. The Nest package itself does not import it.

```sh
pnpm add @taleland/outbox-mikro-orm @mikro-orm/core@^7.2.1 @mikro-orm/postgresql@^7.2.1
```

Apply your application's migration for `OrderSchema` and `OutboxSchema` before starting. For a disposable local database only, you can create the schema with `await orm.schema.create()`.

```ts
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { EntitySchema } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { OutboxModule, OutboxService } from '@taleland/outbox-nestjs';
import { MikroOrmOutboxStorage, OutboxSchema } from '@taleland/outbox-mikro-orm';

class Order {
  id!: string;
  total!: number;
}
const OrderSchema = new EntitySchema<Order>({
  class: Order,
  properties: { id: { type: 'uuid', primary: true }, total: { type: 'integer' } },
});
const orm = await MikroORM.init({
  clientUrl: process.env.DATABASE_URL!,
  entities: [OrderSchema, OutboxSchema],
});

@Injectable()
class OrdersService {
  constructor(private readonly outbox: OutboxService<EntityManager>) {}

  async place(total: number): Promise<string> {
    return this.outbox.withOutbox(async ({ transaction, emit }) => {
      const id = randomUUID();
      transaction.persist(transaction.create(Order, { id, total }));
      emit({ payload: { orderId: id, total } });
      return id;
    });
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(), // Initialize once in the application when jobs are enabled.
    OutboxModule.register({
      storage: new MikroOrmOutboxStorage(orm.em),
      publish: async (payload, { outboxId }) => {
        const response = await fetch(process.env.EVENT_RECEIVER_URL!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': outboxId },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      },
      jobs: {}, // Process every second; clean up at midnight UTC.
    }),
  ],
  providers: [OrdersService],
})
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule);
try {
  const orderId = await app.get(OrdersService).place(4200);
  // Optional explicit invocation, useful in a command-line application:
  await app.get(OutboxService).processOutbox();
  console.log({ orderId });
} finally {
  await app.close(); // Stops scheduled work and waits for active scheduled callbacks.
  await orm.close(); // External resources remain owned by your application.
}
```

In a long-running server, let Nest manage the application's lifetime. Call `app.enableShutdownHooks()` to run lifecycle hooks on process signals. Configure database and publisher timeouts: shutdown waits for active scheduled operations to finish and cannot cancel an external call that never settles. Close externally owned database and transport resources after the outbox jobs drain.

## Asynchronous configuration and DI

Use `registerAsync` when storage or the publisher is supplied by another application module. `imports` exposes those modules to the factory, and `inject` lists their exported provider tokens. The factory may return a promise.

In this example `DatabaseModule` exports a configured `MikroORM` instance and `TransportModule` exports the application's `EVENT_PUBLISHER` token:

```ts
import { Module } from '@nestjs/common';
import { MikroORM, type PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import type { Publish } from '@taleland/outbox-core';
import { OutboxModule } from '@taleland/outbox-nestjs';
import { MikroOrmOutboxStorage } from '@taleland/outbox-mikro-orm';
import { DatabaseModule } from './database.module.js';
import { TransportModule, EVENT_PUBLISHER } from './transport.module.js';

@Module({
  imports: [OutboxModule.registerAsync({
    imports: [DatabaseModule, TransportModule],
    inject: [MikroORM, EVENT_PUBLISHER],
    useFactory: async (orm: CoreMikroORM<PostgreSqlDriver>, publish: Publish) => ({
      storage: new MikroOrmOutboxStorage(orm.em),
      publish,
      process: { batchSize: 50 },
      jobs: false,
    }),
  })],
  exports: [OutboxModule],
})
export class ApplicationOutboxModule {}
```

Use singleton configuration, storage, and publisher providers. Request-scoped dependencies are unsuitable for scheduled work. Configuration failures reject Nest startup. For a global async registration, set `global: true` on `registerAsync` itself, not on the factory's returned value.

## Inject individual operations

`OutboxService<Transaction>` exposes `create`, `withOutbox`, `processOutbox`, and `cleanOutbox`. Their signatures and semantics are the same as the core functions. The transaction type is a TypeScript annotation; it must match your configured storage strategy.

You can also inject the functions directly:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { WithOutbox } from '@taleland/outbox-core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { OUTBOX_SYMBOLS } from '@taleland/outbox-nestjs';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(OUTBOX_SYMBOLS.withOutbox)
    private readonly withOutbox: WithOutbox<EntityManager>,
  ) {}

  async record(orderId: string): Promise<void> {
    await this.withOutbox(async ({ emit }) => {
      emit({ payload: { orderId }, metadata: { eventType: 'orders/placed' } });
    });
  }
}
```

| Token | Function |
| --- | --- |
| `OUTBOX_SYMBOLS.create` | Insert envelopes into a caller-owned transaction. |
| `OUTBOX_SYMBOLS.withOutbox` | Run business work and enqueue events in one storage transaction. |
| `OUTBOX_SYMBOLS.processOutbox` | Publish one eligible batch. |
| `OUTBOX_SYMBOLS.cleanOutbox` | Soft-delete delivered rows older than the configured retention period. |

Business writes must use the transaction supplied by `withOutbox`, or the same caller-owned transaction passed to `create`. The module does not add an ambient transaction or translate broker-specific fields. A publisher receives `payload` and `{ metadata, outboxId }`; interpret routing metadata in your application adapter.

## Optional jobs

Initialize `ScheduleModule.forRoot()` once in the application. `OutboxModule` uses that existing scheduler and does not initialize another scheduler or alter other jobs.

```ts
jobs: {
  process: { cron: '*/5 * * * * *', timeZone: 'UTC' },
  clean: { cron: '0 0 3 * * *', timeZone: 'Europe/London' },
}
```

- Omit `jobs` or set `jobs: false` to disable both jobs. You can invoke the services manually without initializing `ScheduleModule`.
- Set `jobs: {}` to process every second and clean at midnight UTC. Set either `process: false` or `clean: false` to disable that job independently.
- Jobs are registered as `outbox.process` and `outbox.clean` in Nest's `SchedulerRegistry`. These names must be available. Invalid schedules and conflicting names fail startup before any outbox timer starts.
- Scheduled invocations use `waitForCompletion: true`; overlapping ticks of the same job are skipped. Errors are logged through Nest's logger and later ticks can retry. Explicit service calls still propagate errors to the caller.
- On module destruction, jobs stop accepting new work, wait for active scheduled callbacks, and are removed from the registry. Manual service calls are owned and awaited by their callers.
- Every enabled application instance runs its own jobs. Use the storage strategy's concurrency guarantees, such as PostgreSQL `SKIP LOCKED`, for processing across instances. There is no distributed cleanup leader; use `clean: false` on instances that should not perform cleanup.

See [Nest task scheduling](https://docs.nestjs.com/techniques/task-scheduling) for application scheduler setup. Delivery is at least once; the [core documentation](https://github.com/taleland/outbox/tree/main/packages/core) explains retry exhaustion, consumer deduplication, and retention.

## Development

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @taleland/outbox-nestjs test:unit
```

Tests use a real Nest testing container and scheduler. Storage is supplied through the public port; PostgreSQL strategy integration tests run separately in the workspace.

## License

[Apache-2.0](LICENSE).
