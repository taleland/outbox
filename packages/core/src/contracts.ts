import { type OutboxMessage } from './message.js';

/** Payload and optional application-defined metadata; no transport fields are reserved. */
export interface OutboxEvent<Payload extends object = object> {
  readonly payload: Payload;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PublishContext {
  readonly outboxId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type Publish = (payload: object, context: PublishContext) => Promise<void>;

export interface BatchQuery {
  now: Date;
  limit: number;
  maxRetries: number;
}

export interface OutboxBatch {
  messages: readonly OutboxMessage[];
  save: (message: OutboxMessage) => Promise<void>;
}

export interface OutboxStorage<Transaction> {
  transaction: <Result>(work: (transaction: Transaction) => Promise<Result>) => Promise<Result>;
  insert: (messages: readonly OutboxMessage[], transaction: Transaction) => Promise<void>;
  withBatch: (query: BatchQuery, work: (batch: OutboxBatch) => Promise<void>) => Promise<void>;
  cleanDelivered: (createdBefore: Date, deletedAt: Date) => Promise<number>;
}

export interface OutboxLogger {
  debug: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

export interface OutboxUnitOfWork<Transaction> {
  transaction: Transaction;
  emit: <Events extends OutboxEvent[]>(...events: Events) => void;
}

export type Create<Transaction> = <Event extends OutboxEvent>(
  events: readonly Event[], transaction: Transaction
) => Promise<void>;
export type WithOutbox<Transaction> = <Result>(
  work: (uow: OutboxUnitOfWork<Transaction>) => Promise<Result>
) => Promise<Result>;
