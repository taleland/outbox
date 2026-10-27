# Taleland Outbox

A transactional outbox for Node.js. Commit business data and events in one database transaction, then publish the committed events with a background worker.

This pnpm monorepo contains two packages:

| Package | Responsibility |
| --- | --- |
| [`@taleland/outbox-core`](packages/core) | ORM-independent event creation, unit of work, publication, retries, and retention. No runtime dependencies. |
| [`@taleland/outbox-mikro-orm`](packages/mikro-orm) | PostgreSQL persistence, entity schema, transactions, and concurrent worker locking through MikroORM 7. |

The core depends on an `OutboxStorage<Transaction>` interface and a `Publish` callback. It has no dependency on MikroORM, NestJS, or a message broker. Applications choose their storage strategy, transport, and scheduler.

**Initial review:** packages are at `0.0.0` and have not been released. The publishing workflow is disabled until `NPM_PUBLISH_ENABLED=true` is explicitly configured. Installation commands below describe the intended public packages after the first release.

## Requirements

- Node.js 22.17 or later; ESM imports.
- For the MikroORM strategy: PostgreSQL and matching versions of `@mikro-orm/core` and `@mikro-orm/postgresql` in the `^7.2.1` range.
- For development: pnpm 10.28.0 and Docker for PostgreSQL integration tests.

## Install

```sh
pnpm add @taleland/outbox-core @taleland/outbox-mikro-orm @mikro-orm/core@^7.2.1 @mikro-orm/postgresql@^7.2.1
```

For another database or ORM, install only `@taleland/outbox-core` and implement the [storage contract](packages/core/README.md#implementing-a-storage-strategy).

## Commit business data and an event together

Register `OutboxSchema` alongside your application entities, including in the MikroORM configuration used by your migration CLI. Generate and apply a migration to create the `outbox` table before using it. Schema creation in the example below is for a disposable local database; use reviewed migrations in production.

```ts
import { randomUUID } from 'node:crypto';
import { EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { createWithOutbox, createProcessOutbox, createCleanOutbox } from '@taleland/outbox-core';
import { MikroOrmOutboxStorage, OutboxSchema } from '@taleland/outbox-mikro-orm';

class Order {
  id!: string;
  total!: number;
}

const OrderSchema = new EntitySchema<Order>({
  class: Order,
  properties: {
    id: { type: 'uuid', primary: true },
    total: { type: 'integer' },
  },
});

const orm = await MikroORM.init({
  clientUrl: process.env.DATABASE_URL!,
  entities: [OrderSchema, OutboxSchema],
});
// Disposable demo database only:
await orm.schema.create();

const storage = new MikroOrmOutboxStorage(orm.em);
const withOutbox = createWithOutbox(storage);

try {
  const orderId = await withOutbox(async ({ transaction, emit }) => {
    const id = randomUUID();
    transaction.persist(transaction.create(Order, { id, total: 4200 }));
    emit({
      $name: 'orders/placed',
      $version: 1,
      $queueName: 'orders',
      orderId: id,
      total: 4200,
    });
    return id;
  });

  // An HTTP receiver illustrates the transport boundary. A broker adapter can be used instead.
  const processOutbox = createProcessOutbox(storage, async (event, { queueName, outboxId }) => {
    const response = await fetch(`${process.env.EVENT_RECEIVER_URL}/${encodeURIComponent(queueName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': outboxId },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Publication failed: HTTP ${response.status}`);
  });

  await processOutbox(); // One batch; schedule repeated calls in your application.
  const cleanOutbox = createCleanOutbox(storage);
  const deleted = await cleanOutbox();
  console.log({ orderId, deleted });
} finally {
  await orm.close();
}
```

If the callback, event creation, flush, or commit fails, neither the business changes nor its outbox rows commit. Perform all database work through the callback's `transaction`. This strategy opens a new independent transaction; it does not join an ambient transaction. An HTTP call, email, or broker publish performed inside the callback cannot be rolled back by the database.

Events require a nonempty `$name`, a nonnegative integer `$version`, and a nonempty `$queueName`. Other enumerable properties form the payload and must be JSON-serializable. The payload is cloned when outbox rows are created, after the callback completes. Avoid mutating an event after calling `emit`.

## Use an existing transaction

Use `createCreate` when your application already owns a transaction. This joins the supplied transaction rather than opening another one.

```ts
import { createCreate } from '@taleland/outbox-core';

const createOutbox = createCreate(storage);
await orm.em.fork().transactional(async transaction => {
  const id = randomUUID();
  transaction.persist(transaction.create(Order, { id, total: 4200 }));
  await createOutbox([{
    $name: 'orders/placed', $version: 1, $queueName: 'orders', orderId: id,
  }], transaction);
});
```

The MikroORM strategy rejects a nonempty insert outside an active transaction. `createOutbox` flushes the supplied entity manager, including pending business changes, but does not commit it.

## Connect a message bus

The publisher receives `{ ...payload, $name, $version }` and a separate `{ queueName, outboxId }` context. `$queueName` selects a transport; it is not included in the published payload.

For an application using `@taleland/nodets-bus-core`, obtain the configured `GetBus` provider and adapt it:

```ts
import type { GetBus } from '@taleland/nodets-bus-core';
import { createProcessOutbox } from '@taleland/outbox-core';
import type { OutboxStorage } from '@taleland/outbox-core';

export function createBusWorker<Transaction>(storage: OutboxStorage<Transaction>, getBus: GetBus) {
  return createProcessOutbox(storage, async (event, { queueName, outboxId }) => {
    await getBus(queueName).publish(event, { attributes: { outboxId } });
  });
}
```

The selected bus must be initialized and its token must match `$queueName`. Broker exchange and consumer queue bindings belong to the bus configuration. A separate queue per consuming module lets each module receive its own copy; multiple instances sharing one module queue compete for that module's messages.

Define publisher success carefully: the callback must reject on publication failure and resolve only after the acknowledgement required by your application. Check whether your transport waits for durable broker confirmation; resolving after an in-memory enqueue is not a durable delivery guarantee. Configure transport timeouts so a stalled publisher cannot hold database locks indefinitely.

## Run workers and cleanup

`createProcessOutbox` returns a function that processes one batch. Run it repeatedly from your scheduler or worker process, and handle rejected calls so a database failure does not stop future polling. For a simple worker, an awaited loop avoids overlapping calls in one process:

```ts
import { setTimeout as delay } from 'node:timers/promises';

export async function runWorker(processOutbox: () => Promise<void>, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await processOutbox();
    } catch (error) {
      console.error('Outbox batch failed', error);
    }
    if (!signal.aborted) await delay(1000);
  }
}
```

In NestJS, register these functions as providers and call them from your application's scheduled jobs. Use `waitForCompletion: true` for a cron job if you want to prevent overlapping invocations in the same process. Run cleanup less frequently, for example once a day. Stop polling, await any active batch, then close the database and transport during shutdown.

## Delivery semantics and defaults

| Setting | Default |
| --- | --- |
| `batchSize` | 100 messages per call |
| `maxRetries` | 3 retries after the initial attempt, 4 attempts total |
| `retryDelayMs` | 5,000 ms, fixed delay |
| `retentionMs` | 7 days, measured from message creation |

```ts
const processOutbox = createProcessOutbox(storage, publish, {
  batchSize: 50,
  maxRetries: 5,
  retryDelayMs: 10_000,
  logger: {
    debug: message => console.debug(message),
    warn: message => console.warn(message),
    error: (message, error) => console.error(message, error),
  },
});
const cleanOutbox = createCleanOutbox(storage, { retentionMs: 14 * 24 * 60 * 60 * 1000 });
```

- Publishing is **at least once**. A broker can accept a message before the database transaction fails. The same message may then be published again. Consumers should deduplicate using the stable `outboxId` and make their side effects idempotent. Retry exhaustion still requires operator intervention; delivery is not guaranteed indefinitely.
- With PostgreSQL, workers select eligible rows using `FOR UPDATE SKIP LOCKED`, retaining locks until the whole batch commits. Concurrent workers do not process the same locked row. There is no global ordering guarantee between workers.
- Pending rows and failed rows with remaining retries are eligible when `nextAttemptAt` is reached. Deleted, delivered, and exhausted rows are excluded.
- Publisher rejection marks the row `FAILED` and schedules another attempt. Persistence errors reject the batch and roll back its database changes. Earlier publications from that batch may consequently repeat.
- `PROCESSED` is an intermediate state inside the batch transaction. A transaction rollback restores eligibility; the worker does not commit this state as a claim that can become abandoned.
- Cleanup **soft-deletes** delivered rows whose `createdAt` is older than the retention window. It never removes pending or failed events. An old event delivered today may be eligible for cleanup today. Physical deletion, monitoring, and requeueing exhausted events are application responsibilities.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test          # Unit tests, then integration tests using a disposable PostgreSQL container
pnpm pack:check    # Inspect both tarballs and import the isolated core package
```

Build before running tests: tests execute the compiled JavaScript. CI runs the same checks. Dependency PRs from Dependabot are squash-merged only after the PR title check, build, lint, tests, and package checks pass for their current head commit.

Commits and PR titles follow [Conventional Commits 1.0.0](AGENTS.md). The full specification is included locally in `AGENTS.md`.

## Release preparation

Both packages use a fixed Changesets version group. The initial changeset proposes `1.0.0`; it has not been consumed or published.

For a future release, add a changeset with `pnpm changeset`. Prepare a separate version PR by running `pnpm version-packages` and `pnpm install --lockfile-only`, then review the manifests, changelogs, and lockfile. See [Changesets configuration](https://changesets.dev/guide/config) for the fixed-group behavior.

After review and an explicit release decision, configure npm publishing for **both** packages and the `taleland/outbox` repository's `publish.yml` workflow. The workflow uses npm CLI OIDC authentication with no `NPM_TOKEN`; package access and [Trusted Publishers](https://docs.npmjs.com/trusted-publishers/) must be set up before enabling it. Public provenance also requires a public repository. Enabling the repository variable `NPM_PUBLISH_ENABLED=true` allows publishing versioned packages on `main` pushes or manual dispatch. Keep it unset during initial review.

The release command rejects placeholder `0.0.0` versions and unconsumed changesets. It packs through pnpm to resolve `workspace:` dependency ranges, then publishes the tarballs with npm. Already-published versions are skipped, allowing a failed two-package release to be retried. The workflow tags versions only after both packages have been published successfully.

## License

[Apache-2.0](LICENSE).
