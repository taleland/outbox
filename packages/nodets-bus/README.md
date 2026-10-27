# @taleland/outbox-nodets-bus

A node-ts bus publisher adapter for `@taleland/outbox-core`. `createNodeTsPublish(getBus)` returns a `Publish` callback that resolves a named bus, constructs a node-ts event from persisted metadata, and forwards the stable outbox ID as a message attribute.

The adapter has no NestJS or ORM dependency. It accepts the `GetBus` provider from `@taleland/nodets-bus-core`, or an application-owned function returning an initialized node-ts bus instance.

**Unreleased:** this package is part of [taleland/outbox](https://github.com/taleland/outbox). Publishing remains disabled during review.

## Install

After the first release:

```sh
pnpm add @taleland/outbox-nodets-bus @taleland/outbox-core @node-ts/bus-core@^1.3.3
```

Requires Node.js 22.17+ and ESM imports. Configure and initialize the bus separately; the adapter does not create, start, stop, or dispose bus instances.

## Persist routing with the event

```ts
import type { OutboxEvent } from '@taleland/outbox-core';
import type { NodeTsOutboxMetadata } from '@taleland/outbox-nodets-bus';

const event = {
  payload: { orderId: 'order-123', total: 4200 },
  metadata: {
    busToken: 'events',
    eventName: 'orders/created',
    eventVersion: 1,
  } satisfies NodeTsOutboxMetadata,
} satisfies OutboxEvent;

// Inside your existing withOutbox callback:
// emit(event);
```

| Metadata field | Contract |
| --- | --- |
| `busToken` | Nonempty string identifying a configured bus. |
| `eventName` | Nonempty string mapped to the outgoing event's `$name`. |
| `eventVersion` | Nonnegative safe integer mapped to `$version`; zero is supported. |

These fields belong to this adapter, not to the core or the storage strategy. They are persisted with each event so retries use the original routing and schema version. The adapter validates them before resolving a bus. TypeScript's `satisfies` checks field types at creation; runtime validation happens when publishing. Invalid metadata follows the core's normal failure/retry policy and eventually requires operator correction.

The outgoing event is `{ ...payload, $name: eventName, $version: eventVersion }`. Metadata takes precedence if the payload already contains `$name` or `$version`; the adapter does not modify the supplied payload object. Other metadata is not forwarded as payload or message attributes. There is no required `$queueName` field.

## Connect to the core

```ts
import { createProcessOutbox, type OutboxStorage } from '@taleland/outbox-core';
import { createNodeTsPublish, type GetNodeTsBus } from '@taleland/outbox-nodets-bus';

export function createBusWorker<Transaction>(storage: OutboxStorage<Transaction>, getBus: GetNodeTsBus) {
  return createProcessOutbox(storage, createNodeTsPublish(getBus), {
    batchSize: 100,
    maxRetries: 3,
    retryDelayMs: 5000,
  });
}
```

The resolver is called on each publication attempt, not when the factory is created. Unknown or uninitialized buses and rejected publications propagate to the core, which records failure and schedules retries. The adapter awaits `bus.publish()` and never retries independently.

Each call forwards `{ attributes: { outboxId } }`. Consumers should deduplicate on this stable ID: a retry can publish the event again after a broker accepted it but the database transaction failed. Awaiting `bus.publish()` only provides the acknowledgement guarantees of the configured transport; the adapter does not add publisher confirms. Configure transport timeouts so publication cannot hold database locks indefinitely.

## NestJS dependency injection

Install `@taleland/outbox-nestjs`, your storage strategy, and `@taleland/nodets-bus-core` with their peer dependencies. In this example:

- `DatabaseModule` exports the configured PostgreSQL `EntityManager` provider and registers `OutboxSchema` with the ORM.
- `MessagingModule` imports and re-exports `NodeTsBusCoreModule.forRoot(...)`, with a transport registered under the `events` token. Initialize it once in the application.
- Initialize `ScheduleModule.forRoot()` once at the application root to enable the outbox worker.

```ts
import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { NODETS_BUS_CORE_SYMBOLS, type GetBus } from '@taleland/nodets-bus-core';
import { OutboxModule } from '@taleland/outbox-nestjs';
import { MikroOrmOutboxStorage } from '@taleland/outbox-mikro-orm';
import { createNodeTsPublish } from '@taleland/outbox-nodets-bus';
import { DatabaseModule } from './database.module.js';
import { MessagingModule } from './messaging.module.js';

@Module({
  imports: [OutboxModule.registerJobsAsync({
    imports: [DatabaseModule, MessagingModule],
    inject: [EntityManager, NODETS_BUS_CORE_SYMBOLS.getBusInstance],
    useFactory: (em: EntityManager, getBus: GetBus) => ({
      storage: new MikroOrmOutboxStorage(em),
      publish: createNodeTsPublish(getBus),
    }),
  })],
  exports: [OutboxModule],
})
export class ApplicationOutboxModule {}
```

Use `registerAsync` instead of `registerJobsAsync` for applications that only enqueue events or supply their own scheduler. No separate publisher module is required: the existing async factory connects storage and publishing. `NodeTsBusCoreModule` owns bus initialization; its current Nest integration expects an HTTP application using Fastify. For a standalone worker without HTTP, configure node-ts bus directly and supply your own resolver.

## Exchanges and module queues

`busToken` selects a publishing transport; it is not the destination consumer queue. Configure the exchange and subscriptions in the bus layer. Give each consuming module its own queue bound to the event's exchange/routing rules to receive its own copy. Replicas of the same module share that module's queue and compete for messages. Publish once through the outbox; do not create one outbox row per subscriber.

See [module queue examples](https://github.com/taleland/nodets-bus-core#readme) for bus configuration. The [core README](../core/README.md) describes retries, transactions, retention, and delivery semantics.

## Development

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @taleland/outbox-nodets-bus test:unit
```

## License

[Apache-2.0](LICENSE).
