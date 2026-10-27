# @taleland/outbox-mikro-orm

MikroORM 7 PostgreSQL storage strategy for `@taleland/outbox-core`. Business writes and outbox events share one transaction; concurrent publishing workers use `FOR UPDATE SKIP LOCKED`.

## Install

```sh
pnpm add @taleland/outbox-core @taleland/outbox-mikro-orm @mikro-orm/core@^7.2.1 @mikro-orm/postgresql@^7.2.1
```

Use Node.js 22.17+ and matching MikroORM core/driver versions. The strategy is PostgreSQL-specific.

## Register the schema and create an outbox

```ts
import { MikroORM } from '@mikro-orm/postgresql';
import { createWithOutbox, createProcessOutbox } from '@taleland/outbox-core';
import { MikroOrmOutboxStorage, OutboxSchema } from '@taleland/outbox-mikro-orm';

const orm = await MikroORM.init({
  clientUrl: process.env.DATABASE_URL!,
  entities: [OutboxSchema], // Add your application's entity schemas here.
});
const storage = new MikroOrmOutboxStorage(orm.em);
const withOutbox = createWithOutbox(storage);

await withOutbox(async ({ transaction, emit }) => {
  // Save business entities with `transaction` so they commit with the event.
  // transaction.persist(transaction.create(Order, { id: orderId, total: 4200 }));
  emit({
    payload: { orderId: 'order-123' },
  });
});

const processOutbox = createProcessOutbox(storage, async (payload, context) => {
  // Replace with your transport's acknowledged publish operation.
  const response = await fetch(process.env.EVENT_RECEIVER_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': context.outboxId },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
});
try {
  await processOutbox();
} finally {
  await orm.close();
}
```

Create the schema with a migration before running this example. The [root README](https://github.com/taleland/outbox#readme) includes a complete business entity example, existing-transaction usage, and a message-bus adapter.

## Migrations

Include the exported `OutboxSchema` in both runtime and migration CLI configuration. Generate, review, and apply a migration in the consuming application. The library does not create or alter tables automatically. The initial schema has no dedicated event-name, version, or queue columns; transport-specific data belongs in application-defined metadata. If you created a local schema from an earlier initial-PR revision, regenerate its migration or recreate the disposable database.

The schema maps `OutboxMessage` to the `outbox` table, including a UUID primary key, JSONB `payload` and `metadata` objects, state/retry fields, timestamps, and an index on `state`, `nextAttemptAt`, and `createdAt`. MikroORM's naming strategy determines property column names; keep the same configuration in migrations and at runtime.

## Transactions and workers

`MikroOrmOutboxStorage.transaction` forks an isolated entity manager with `REQUIRES_NEW` propagation. `createWithOutbox` therefore starts a new independent transaction even if called inside an existing one. Use the supplied `transaction` entity manager for every business write that should commit with emitted events.

If your application owns the transaction, call `createCreate(storage)(events, transaction)` with its active entity manager. It flushes pending changes but does not commit; rollback remains the caller's responsibility.

Workers lock eligible rows for the complete batch transaction. Multiple workers skip each other's locked rows, and a crashed/rolled-back transaction makes its messages eligible again. The publisher runs while these locks are held: bound network calls with timeouts, keep batches manageable, and provision enough database connections for your workers.

Publishing is at least once. A successful broker publish followed by database rollback can produce a duplicate on the next poll. Deduplicate by the stable `outboxId`. Failed publications are retried with a fixed delay; exhausted failures remain stored. Cleanup soft-deletes only delivered messages older than the creation-based retention cutoff.

## Development

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:integration
```

Integration tests start a disposable PostgreSQL container through Testcontainers and exercise atomic commits, rollback, caller-owned transactions, concurrent workers, retries, and retention. Docker must be running.

## License

Apache-2.0. See [LICENSE](LICENSE).
