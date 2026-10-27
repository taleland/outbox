import { type FactoryProvider } from '@nestjs/common';
import { createCleanOutbox } from '@taleland/outbox-core';
import { type OutboxModuleOptions } from '../options.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from '../symbols.js';

export const cleanOutboxProvider: FactoryProvider<() => Promise<number>> = {
  provide: OUTBOX_SYMBOLS.cleanOutbox,
  inject: [OUTBOX_OPTIONS],
  useFactory: (options: OutboxModuleOptions) => createCleanOutbox(options.storage, options.clean),
};
