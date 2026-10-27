# @taleland/outbox-core

ORM-independent transactional outbox primitives for Node.js 22.17+. No runtime dependencies, ORM decorators, framework providers, or broker client are required.

## Usage

```sh
pnpm add @taleland/outbox-core
```

Compose the core with a storage strategy and a publisher. In this example `storage` implements `OutboxStorage<Transaction>` and `publish` implements `Publish`:

```ts
import { createWithOutbox, createProcessOutbox, createCleanOutbox } from '@taleland/outbox-core';
import type { OutboxStorage, Publish } from '@taleland/outbox-core';

export function createOutboxServices<Transaction>(storage: OutboxStorage<Transaction>, publish: Publish) {
  return {
    withOutbox: createWithOutbox(storage),
    processOutbox: createProcessOutbox(storage, publish),
    cleanOutbox: createCleanOutbox(storage),
  };
}
```

Use `withOutbox(async ({ transaction, emit }) => { ... })` to save business changes through the supplied transaction and collect events. The callback's result is returned after commit. Each event is an envelope containing a JSON-serializable `payload` object and optional application-defined `metadata`:

```ts
await withOutbox(async ({ transaction, emit }) => {
  await orders.save({ id: orderId, total: 4200 }, transaction);
  emit({ payload: { orderId } });
});
```

Here `orders` is your application repository and `orderId` is the business identifier. To join a caller-owned transaction, use `createCreate(storage)(events, transaction)` instead.

The publisher receives the payload unchanged, plus `{ metadata, outboxId }`. Metadata defaults to `{}`; the core does not interpret its keys. Neither the payload nor metadata has reserved fields or a required event name, version, or destination. Retried publications preserve `outboxId`. Await the transport acknowledgement you require, reject on failures, and enforce a transport timeout. Run `processOutbox()` repeatedly; each call processes one batch. Run `cleanOutbox()` periodically; it returns the number of soft-deleted rows.

See the [complete PostgreSQL example, bus adapter, scheduling, and delivery semantics](https://github.com/taleland/outbox#readme).

## Application-defined metadata

```ts
emit({
  payload: { orderId, total: 4200 },
  metadata: { topic: 'orders.created', headers: { correlationId: 'request-123' } },
});
```

The publisher can interpret `topic` and `headers`, or use any other application-defined convention. The core only stores them. Validate transport-specific metadata in your adapter and create the broker's message format there. Payloads may be plain objects or data-only class instances without an index signature; persisted data is not rehydrated into the original class.

Payload and metadata are cloned after the unit-of-work callback finishes. Do not mutate an emitted envelope before that point. Each publisher invocation receives fresh copies to protect the stored message from adapter mutations on retries. Both objects must be JSON-serializable; functions, cyclic structures, and other non-JSON values are unsupported.

## Implementing a storage strategy

```ts
import type { OutboxStorage } from '@taleland/outbox-core';

// Your transaction type is inferred throughout createCreate and createWithOutbox.
const storage: OutboxStorage<YourTransaction> = yourStorageImplementation;
```

The storage interface is a transactional contract, not just CRUD:

| Method | Required behavior |
| --- | --- |
| `transaction(work)` | Open a transaction; supply its handle; commit only after `work` succeeds; roll back on any rejection, flush failure, or commit failure; return the callback result. Document whether ambient transactions are joined or isolated. |
| `insert(messages, transaction)` | Persist each row's payload and metadata without interpreting their keys, within the supplied active transaction and atomically with the caller's business changes. Never commit independently. Empty input is a no-op. |
| `withBatch(query, work)` | Exclusively claim at most `limit` eligible rows and keep ownership until the callback and commit complete. Include only undeleted `PENDING` rows or `FAILED` rows with `retries < maxRetries`, with `nextAttemptAt <= now`. Use a deterministic order. Other workers must skip claimed rows. |
| `batch.save(message)` | Persist the complete state change in the same batch transaction. Propagate storage errors. A failed callback or commit must roll back all saves and release ownership. `PROCESSED` must not survive a rollback. |
| `cleanDelivered(createdBefore, deletedAt)` | Atomically soft-delete undeleted `DELIVERED` rows with `createdAt < createdBefore`, setting `deletedAt` and `updatedAt`. Return the affected count and preserve pending/failed rows. |

Returned rows must support the `OutboxMessage` state transitions (`process`, `fail`, `delivery`). If your driver returns plain records, hydrate `OutboxMessage` instances. Do not commit a claim separately from the batch: this API relies on transaction rollback for crash recovery. Storage engines using leases require their own recovery mechanism before they can fulfill this contract.

The core cannot enforce these guarantees on a custom strategy. Test rollback, insertion failure, overlapping workers, retry eligibility, and retention against the real database. Use the [MikroORM strategy](https://github.com/taleland/outbox/tree/main/packages/mikro-orm) as a complete implementation.

## Options and state

- `createCreate(storage, { now?, uuid?, logger? })`: validate envelope object shapes, clone payloads and metadata, assign stable IDs, and insert rows. `now` and `uuid` can be injected for deterministic tests.
- `createWithOutbox(storage, create?)`: collect events during a transaction and insert them before commit. `emit` is invalid after the callback finishes.
- `createProcessOutbox(storage, publish, { batchSize?, maxRetries?, retryDelayMs?, now?, logger? })`: defaults to 100 rows, 3 retries after the initial attempt, and 5 seconds between attempts.
- `createCleanOutbox(storage, { retentionMs?, now? })`: defaults to 7 days from creation, and only soft-deletes delivered messages.

State transitions are `PENDING → PROCESSED → DELIVERED` or `PENDING → PROCESSED → FAILED`; eligible retries go `FAILED → PROCESSED`. A retry increments `retries`; the initial attempt does not. Exhausted failed messages remain stored for inspection. Delivery is at least once: use `outboxId` for consumer deduplication. Database rollback cannot undo an external publish.

## License

Apache-2.0. See [LICENSE](LICENSE).
