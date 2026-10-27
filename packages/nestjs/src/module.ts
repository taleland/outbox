import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { OutboxJobs } from './jobs.js';
import { type OutboxModuleAsyncOptions, type OutboxModuleOptions } from './options.js';
import { OutboxService } from './outbox.service.js';
import { createProvider, withOutboxProvider, processOutboxProvider, cleanOutboxProvider } from './service/index.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from './symbols.js';

@Module({})
export class OutboxModule {
  static register<Transaction> (options: OutboxModuleOptions<Transaction>): DynamicModule {
    return this.configure({ provide: OUTBOX_OPTIONS, useValue: options }, options.global);
  }

  static registerAsync<Transaction> (options: OutboxModuleAsyncOptions<Transaction>): DynamicModule {
    return this.configure({
      provide: OUTBOX_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory,
    }, options.global, options.imports);
  }

  private static configure (
    optionsProvider: Provider, global = false, imports: DynamicModule['imports'] = []
  ): DynamicModule {
    return {
      module: OutboxModule,
      global,
      imports,
      providers: [
        optionsProvider, createProvider, withOutboxProvider, processOutboxProvider, cleanOutboxProvider,
        OutboxService, OutboxJobs,
      ],
      exports: [OutboxService, ...Object.values(OUTBOX_SYMBOLS)],
    };
  }
}
