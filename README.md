# Taleland Outbox

A transactional outbox for Node.js. Commit business data and events in one database transaction, then publish the committed events with a background worker.

This pnpm monorepo contains four packages:

| Package | Responsibility |
| --- | --- |
| [`@taleland/outbox-core`](packages/core) | ORM-independent event creation, unit of work, publication, retries, and retention. No runtime dependencies. |
| [`@taleland/outbox-mikro-orm`](packages/mikro-orm) | PostgreSQL persistence, entity schema, transactions, and concurrent worker locking through MikroORM 7. |
| [`@taleland/outbox-nestjs`](packages/nestjs) | NestJS module, injectable services, async configuration, and optional scheduled jobs. |
| [`@taleland/outbox-nodets-bus`](packages/nodets-bus) | Publisher adapter for named node-ts buses, routing metadata, and stable outbox IDs. |

The core depends on an `OutboxStorage<Transaction>` interface and a `Publish` callback. It has no dependency on MikroORM, NestJS, or a message broker. Applications choose their storage strategy, transport, and scheduler.

## Requirements

- Node.js 22.17 or later; ESM imports.
- For the MikroORM strategy: PostgreSQL and matching versions of `@mikro-orm/core` and `@mikro-orm/postgresql` in the `^7.2.1` range.
- For development: pnpm 10.28.0 and Docker for PostgreSQL integration tests.

## Install

```sh
pnpm add @taleland/outbox-core @taleland/outbox-mikro-orm @mikro-orm/core@^7.2.1 @mikro-orm/postgresql@^7.2.1
```

For another database or ORM, install only `@taleland/outbox-core` and implement the [storage contract](packages/core/README.md#implementing-a-storage-strategy).

## NestJS integration

Use [`@taleland/outbox-nestjs`](packages/nestjs) for `OutboxModule.register` / `registerAsync`, injectable `OutboxService`, and optional processing/cleanup jobs. Supply your storage strategy and publisher through configuration. The NestJS package does not depend on MikroORM.

```sh
pnpm add @taleland/outbox-nestjs @taleland/outbox-core @nestjs/schedule@^12.0.2
```

See the [NestJS README](packages/nestjs/README.md) for a complete application example, async DI configuration, individual provider tokens, and shutdown behavior. Use `registerJobs` / `registerJobsAsync` to enable the built-in `@Cron` tasks; the application initializes `ScheduleModule.forRoot()` once. `register` / `registerAsync` provide services without background jobs.

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
      payload: { orderId: id, total: 4200 },
    });
    return id;
  });

  // An HTTP receiver illustrates the transport boundary. A broker adapter can be used instead.
  const processOutbox = createProcessOutbox(storage, async (payload, { outboxId }) => {
    const response = await fetch(process.env.EVENT_RECEIVER_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': outboxId },
      body: JSON.stringify(payload),
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

Events are envelopes with a `payload` object and an optional `metadata` object. Both must contain JSON-serializable data. The core imposes no event-name, version, destination, or broker-specific fields and reserves no keys inside either object. Metadata defaults to `{}` and can carry application-defined routing information, headers, or tracing data.

Payload and metadata are cloned when outbox rows are created, after the callback completes. Avoid mutating an envelope after calling `emit`. Each publication attempt receives fresh copies, so a publisher cannot accidentally mutate the stored data used for retries.

## Use an existing transaction

Use `createCreate` when your application already owns a transaction. This joins the supplied transaction rather than opening another one.

```ts
import { createCreate } from '@taleland/outbox-core';

const createOutbox = createCreate(storage);
await orm.em.fork().transactional(async transaction => {
  const id = randomUUID();
  transaction.persist(transaction.create(Order, { id, total: 4200 }));
  await createOutbox([{
    payload: { orderId: id },
  }], transaction);
});
```

The MikroORM strategy rejects a nonempty insert outside an active transaction. `createOutbox` flushes the supplied entity manager, including pending business changes, but does not commit it.

## Connect a message bus

The publisher receives the stored `payload` unchanged and a separate `{ metadata, outboxId }` context. The application adapter interprets metadata and converts the payload to its transport's format.

Use [`@taleland/outbox-nodets-bus`](packages/nodets-bus) with `@taleland/nodets-bus-core` or directly configured node-ts bus instances:

```ts
emit({
  payload: { orderId },
  metadata: { busToken: 'events', eventName: 'orders/created', eventVersion: 1 },
});
```

The adapter validates this metadata, creates the bus event, and forwards the stable outbox ID:

```ts
import { createProcessOutbox, type OutboxStorage } from '@taleland/outbox-core';
import { createNodeTsPublish, type GetNodeTsBus } from '@taleland/outbox-nodets-bus';

export function createBusWorker<Transaction>(storage: OutboxStorage<Transaction>, getBus: GetNodeTsBus) {
  return createProcessOutbox(storage, createNodeTsPublish(getBus));
}
```

See the [publisher README](packages/nodets-bus/README.md) for the metadata contract and a complete Nest DI configuration using `OutboxModule.registerJobsAsync`.

The selected bus must be initialized. Broker exchange and consumer queue bindings belong to the bus configuration. A separate queue per consuming module lets each module receive its own copy; multiple instances sharing one module queue compete for that module's messages. HTTP, Kafka, or other publishers can use entirely different metadata or none at all.

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

In NestJS, use `OutboxModule` from `@taleland/outbox-nestjs` to register providers. Choose `registerJobs` or `registerJobsAsync` for Nest `@Cron` tasks with `waitForCompletion: true`. Run cleanup less frequently, for example once a day. Stop polling, await any active batch, then close the database and transport during shutdown.

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
pnpm pack:check    # Inspect all four tarballs and import the isolated core package
```

Build before running tests: tests execute the compiled JavaScript. CI runs the same checks. Dependency PRs from Dependabot are squash-merged only after the PR title check, build, lint, tests, and package checks pass for their current head commit.

Commits and PR titles follow [Conventional Commits 1.0.0](AGENTS.md). The full specification is included locally in `AGENTS.md`.

## Independent releases

Each package has its own version, `CHANGELOG.md`, Git tag (`@taleland/outbox-core@1.2.3`), and GitHub Release. `semantic-release-monorepo` filters commits since that package's last tag; the shared release plugins analyze Conventional Commits and publish only affected packages. A core release does not automatically bump the adapters.

Source changes, package TypeScript configuration, and published manifest fields participate in release analysis. `fix`/`perf` produce patches, `feat` produces minor versions, and breaking changes produce majors. Runtime dependency updates using `chore(deps)` or `build(deps)` produce patches. Documentation, tests, CI, version-only commits, and development-only dependencies do not trigger releases. Commit scopes are descriptive: changed file paths decide which package is affected.

Internal dependencies use explicit supported npm ranges. Root pnpm overrides link local packages for development without changing those published ranges. To adopt an incompatible core major, update the adapter's code and dependency range explicitly. Never widen a published range automatically just because core was released.

On `main`, CI runs lint, build, tests, and tarball checks before sequential releases (core first). Standard semantic-release plugins update package versions and changelogs, commit them, publish to npm, and create GitHub Releases. Publication waits for registry visibility before proceeding. There are no Changeset files or manual version PRs.

Configure npm Trusted Publishers for every package with repository `taleland/outbox` and workflow `publish.yml`, then enable `NPM_PUBLISH_ENABLED=true` when publication is approved. Publishing uses npm OIDC with `id-token: write`; no npm token is required. Keep the variable disabled during initial setup. A recreated GitHub repository has a new identity, so its Trusted Publishers must be configured again.

`pnpm release:dry-run` previews versions using the same configuration; semantic-release still verifies Git/npm authentication. The release tests use local Git fixtures and never publish anything.

### Recovering partial publication

Semantic-release creates a tag before npm publication. If publication or registry propagation fails, the next release run stops at the incomplete tag instead of inventing another version. Dispatch `publish.yml` on `main` with `recover_tag` set to that exact package tag. Recovery checks out the immutable tagged snapshot, rebuilds it, skips an npm version already present, and creates a missing GitHub Release. Authentication errors remain errors. After recovery, dispatch the normal workflow with an empty `recover_tag` to continue other packages.

See the [changelog index](CHANGELOG.md) and [GitHub Releases](https://github.com/taleland/outbox/releases).

## License

[Apache-2.0](LICENSE).
