import { type FactoryProvider } from '@nestjs/common';
import { createProcessOutbox } from '@taleland/outbox-core';
import { type OutboxModuleOptions } from '../options.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from '../symbols.js';

export const processOutboxProvider: FactoryProvider<() => Promise<void>> = {
  provide: OUTBOX_SYMBOLS.processOutbox,
  inject: [OUTBOX_OPTIONS],
  useFactory: (options: OutboxModuleOptions) => createProcessOutbox(options.storage, options.publish, options.process),
};
