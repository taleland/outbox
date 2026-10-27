import { Inject, Injectable } from '@nestjs/common';
import { type Create, type WithOutbox } from '@taleland/outbox-core';
import { OUTBOX_SYMBOLS } from './symbols.js';

@Injectable()
export class OutboxService<Transaction = unknown> {
  constructor (
    @Inject(OUTBOX_SYMBOLS.create) public readonly create: Create<Transaction>,
    @Inject(OUTBOX_SYMBOLS.withOutbox) public readonly withOutbox: WithOutbox<Transaction>,
    @Inject(OUTBOX_SYMBOLS.processOutbox) public readonly processOutbox: () => Promise<void>,
    @Inject(OUTBOX_SYMBOLS.cleanOutbox) public readonly cleanOutbox: () => Promise<number>
  ) {}
}
