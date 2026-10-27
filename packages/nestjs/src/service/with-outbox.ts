import { type FactoryProvider } from '@nestjs/common';
import { createWithOutbox, type Create, type WithOutbox } from '@taleland/outbox-core';
import { type OutboxModuleOptions } from '../options.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from '../symbols.js';

export const withOutboxProvider: FactoryProvider<WithOutbox<unknown>> = {
  provide: OUTBOX_SYMBOLS.withOutbox,
  inject: [OUTBOX_OPTIONS, OUTBOX_SYMBOLS.create],
  useFactory: (options: OutboxModuleOptions, create: Create<unknown>) => createWithOutbox(options.storage, create),
};
