import { type FactoryProvider, type ModuleMetadata } from '@nestjs/common';
import {
  type CleanOutboxOptions, type CreateOptions, type OutboxStorage,
  type ProcessOutboxOptions, type Publish,
} from '@taleland/outbox-core';

export interface OutboxCronOptions {
  cron?: string;
  timeZone?: string;
}

export interface OutboxJobsOptions {
  /** Defaults to every second. Set false to disable processing on this instance. */
  process?: OutboxCronOptions | false;
  /** Defaults to midnight UTC. Set false to disable cleanup on this instance. */
  clean?: OutboxCronOptions | false;
}

export interface OutboxModuleOptions<Transaction = unknown> {
  storage: OutboxStorage<Transaction>;
  publish: Publish;
  create?: CreateOptions;
  process?: ProcessOutboxOptions;
  clean?: CleanOutboxOptions;
  /** Scheduling is disabled unless an options object is supplied. */
  jobs?: OutboxJobsOptions | false;
  global?: boolean;
}

export interface OutboxModuleAsyncOptions<Transaction = unknown> extends Pick<ModuleMetadata, 'imports'> {
  global?: boolean;
  inject?: FactoryProvider['inject'];
  useFactory: (...dependencies: any[]) => OutboxModuleOptions<Transaction> | Promise<OutboxModuleOptions<Transaction>>;
}
