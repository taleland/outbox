# @taleland/outbox

ORM-independent transactional outbox primitives for Node.js 22.17+. No runtime dependencies, ORM decorators, framework providers, or broker client are required.

**Unreleased:** this package is part of the initial review of [taleland/outbox](https://github.com/taleland/outbox).

## Usage

After the first release:

```sh
pnpm add @taleland/outbox
```

Compose the core with a storage strategy and a publisher. In this example `storage` implements `OutboxStorage<Transaction>` and `publish` implements `Publish`:

```ts
import { createWithOutbox, createProcessOutbox, createCleanOutbox } from '@taleland/outbox';
import type { OutboxStorage, Publish } from '@taleland/outbox';

export function createOutboxServices<Transaction>(storage: OutboxStorage<Transaction>, publish: Publish) {
  return {
    withOutbox: createWithOutbox(storage),
    processOutbox: createProcessOutbox(storage, publish),
    cleanOutbox: createCleanOutbox(storage),
  };
}
```

Use `withOutbox(async ({ transaction, emit }) => { ... })` to save business changes through the supplied transaction and collect events. The callback's result is returned after commit. Each event includes `$name`, `$version`, and `$queueName`, plus a JSON-serializable payload:

```ts
await withOutbox(async ({ transaction, emit }) => {
  await orders.save({ id: orderId, total: 4200 }, transaction);
  emit({ $name: 'orders/placed', $version: 1, $queueName: 'orders', orderId });
});
```

Here `orders` is your application repository and `orderId` is the business identifier. To join a caller-owned transaction, use `createCreate(storage)(events, transaction)` instead.

The publisher receives the event payload with `$name` and `$version`, plus `{ queueName, outboxId }`. Retried publications preserve `outboxId`. Await the transport acknowledgement you require, reject on failures, and enforce a transport timeout. Run `processOutbox()` repeatedly; each call processes one batch. Run `cleanOutbox()` periodically; it returns the number of soft-deleted rows.

See the [complete PostgreSQL example, bus adapter, scheduling, and delivery semantics](https://github.com/taleland/outbox#readme).

## Implementing a storage strategy

```ts
import type { OutboxStorage } from '@taleland/outbox';

// Your transaction type is inferred throughout createCreate and createWithOutbox.
const storage: OutboxStorage<YourTransaction> = yourStorageImplementation;
```

The storage interface is a transactional contract, not just CRUD:

| Method | Required behavior |
| --- | --- |
| `transaction(work)` | Open a transaction; supply its handle; commit only after `work` succeeds; roll back on any rejection, flush failure, or commit failure; return the callback result. Document whether ambient transactions are joined or isolated. |
| `insert(messages, transaction)` | Persist all supplied rows within the supplied active transaction, atomically with the caller's business changes. Never commit independently. Empty input is a no-op. |
| `withBatch(query, work)` | Exclusively claim at most `limit` eligible rows and keep ownership until the callback and commit complete. Include only undeleted `PENDING` rows or `FAILED` rows with `retries < maxRetries`, with `nextAttemptAt <= now`. Use a deterministic order. Other workers must skip claimed rows. |
| `batch.save(message)` | Persist the complete state change in the same batch transaction. Propagate storage errors. A failed callback or commit must roll back all saves and release ownership. `PROCESSED` must not survive a rollback. |
| `cleanDelivered(createdBefore, deletedAt)` | Atomically soft-delete undeleted `DELIVERED` rows with `createdAt < createdBefore`, setting `deletedAt` and `updatedAt`. Return the affected count and preserve pending/failed rows. |

Returned rows must support the `OutboxMessage` state transitions (`process`, `fail`, `delivery`). If your driver returns plain records, hydrate `OutboxMessage` instances. Do not commit a claim separately from the batch: this API relies on transaction rollback for crash recovery. Storage engines using leases require their own recovery mechanism before they can fulfill this contract.

The core cannot enforce these guarantees on a custom strategy. Test rollback, insertion failure, overlapping workers, retry eligibility, and retention against the real database. Use the [MikroORM strategy](https://github.com/taleland/outbox/tree/main/packages/mikro-orm) as a complete implementation.

## Options and state

- `createCreate(storage, { now?, uuid?, logger? })`: validate metadata, clone payloads, assign stable IDs, and insert rows. `now` and `uuid` can be injected for deterministic tests.
- `createWithOutbox(storage, create?)`: collect events during a transaction and insert them before commit. `emit` is invalid after the callback finishes.
- `createProcessOutbox(storage, publish, { batchSize?, maxRetries?, retryDelayMs?, now?, logger? })`: defaults to 100 rows, 3 retries after the initial attempt, and 5 seconds between attempts.
- `createCleanOutbox(storage, { retentionMs?, now? })`: defaults to 7 days from creation, and only soft-deletes delivered messages.

State transitions are `PENDING → PROCESSED → DELIVERED` or `PENDING → PROCESSED → FAILED`; eligible retries go `FAILED → PROCESSED`. A retry increments `retries`; the initial attempt does not. Exhausted failed messages remain stored for inspection. Delivery is at least once: use `outboxId` for consumer deduplication. Database rollback cannot undo an external publish.

## License

Apache-2.0. See [LICENSE](LICENSE).
