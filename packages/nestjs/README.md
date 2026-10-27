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
  });
}
```

Import the returned dynamic module in the Nest module that needs outbox services. Set `global: true` to make the services available to all modules, or re-export `OutboxModule` through a shared application module. Register one configured outbox module per application. `register` and `registerAsync` provide services without scheduling work. Use `registerJobs` or `registerJobsAsync` with the same configuration when this application should also process and clean up the outbox.

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
    OutboxModule.registerJobs({
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
    }),
  })],
  exports: [OutboxModule],
})
export class ApplicationOutboxModule {}
```

Use singleton configuration, storage, and publisher providers. Request-scoped dependencies are unsuitable for scheduled work. Configuration failures reject Nest startup. For a global async registration, set `global: true` on `registerAsync` itself, not on the factory's returned value.

For node-ts bus publishing, use `createNodeTsPublish(getBus)` from [`@taleland/outbox-nodets-bus`](../nodets-bus/README.md#nestjs-dependency-injection). Its README shows how to inject the named bus resolver alongside the storage strategy.

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

Initialize `ScheduleModule.forRoot()` once in the application and choose `OutboxModule.registerJobs(options)` instead of `register(options)`. For dependency injection, choose `registerJobsAsync(options)` instead of `registerAsync(options)`; it accepts the same `imports`, `inject`, and `useFactory` configuration. Each variant exports the same outbox services. Do not register both variants in the same application.

The built-in worker uses Nest's `@Cron` decorators and `CronExpression` constants:

| Job name | Schedule | Behavior |
| --- | --- | --- |
| `outbox.process` | `CronExpression.EVERY_SECOND` | Publish one eligible batch. |
| `outbox.clean` | `CronExpression.EVERY_DAY_AT_MIDNIGHT`, UTC | Soft-delete delivered history according to retention settings. |

Nest registers, starts, and removes these jobs through `@nestjs/schedule`. Both use `waitForCompletion: true`, so overlapping ticks of the same job are skipped. Nest logs scheduled errors and later ticks can retry. Explicit service calls propagate errors to the caller.

On module destruction, the worker stops accepting new work and waits for active scheduled operations; Nest removes its timers during application shutdown. Await `app.close()` before closing externally owned resources. Manual service calls are owned and awaited by their callers.

Every application instance using `registerJobs` or `registerJobsAsync` runs its own worker. Use the storage strategy's concurrency guarantees, such as PostgreSQL `SKIP LOCKED`, for processing across instances. API instances that only enqueue events should use `register` or `registerAsync`. There is no distributed cleanup leader.

### Custom schedules

Use `register` or `registerAsync` and declare application-owned Nest providers when you need different schedules, a different time zone, or only one of the jobs. This uses the same Nest scheduling API as any other application task:

```ts
import { Injectable, Module } from '@nestjs/common';
import { Cron, CronExpression, ScheduleModule } from '@nestjs/schedule';
import { OutboxModule, OutboxService } from '@taleland/outbox-nestjs';
import type { OutboxStorage, Publish } from '@taleland/outbox-core';

@Injectable()
class ApplicationOutboxJobs {
  constructor(private readonly outbox: OutboxService) {}

  @Cron(CronExpression.EVERY_5_SECONDS, { waitForCompletion: true })
  async process(): Promise<void> {
    await this.outbox.processOutbox();
  }

  @Cron('0 0 3 * * *', { timeZone: 'Europe/London', waitForCompletion: true })
  async clean(): Promise<void> {
    await this.outbox.cleanOutbox();
  }
}

@Module({})
export class MessagingModule {
  static register<Transaction>(storage: OutboxStorage<Transaction>, publish: Publish) {
    return {
      module: MessagingModule,
      imports: [ScheduleModule.forRoot(), OutboxModule.register({ storage, publish })],
      providers: [ApplicationOutboxJobs],
    };
  }
}
```

If your root module already imports `ScheduleModule.forRoot()`, omit it from `MessagingModule`. Application-owned jobs must also coordinate their active operations with resource shutdown; the built-in worker's drain hook only covers its own scheduled operations.

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
