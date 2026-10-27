import { type FactoryProvider, type ModuleMetadata } from '@nestjs/common';
import {
  type CleanOutboxOptions, type CreateOptions, type OutboxStorage,
  type ProcessOutboxOptions, type Publish,
} from '@taleland/outbox-core';

export interface OutboxModuleOptions<Transaction = unknown> {
  storage: OutboxStorage<Transaction>;
  publish: Publish;
  create?: CreateOptions;
  process?: ProcessOutboxOptions;
  clean?: CleanOutboxOptions;
  global?: boolean;
}

export interface OutboxModuleAsyncOptions<Transaction = unknown> extends Pick<ModuleMetadata, 'imports'> {
  global?: boolean;
  inject?: FactoryProvider['inject'];
  useFactory: (...dependencies: any[]) => OutboxModuleOptions<Transaction> | Promise<OutboxModuleOptions<Transaction>>;
}
