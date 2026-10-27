import { type FactoryProvider } from '@nestjs/common';
import { createCreate, type Create } from '@taleland/outbox-core';
import { type OutboxModuleOptions } from '../options.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from '../symbols.js';

export const createProvider: FactoryProvider<Create<unknown>> = {
  provide: OUTBOX_SYMBOLS.create,
  inject: [OUTBOX_OPTIONS],
  useFactory: (options: OutboxModuleOptions) => createCreate(options.storage, options.create),
};
