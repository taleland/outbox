import { Inject, Injectable, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { OUTBOX_SYMBOLS } from '../symbols.js';

@Injectable()
export class OutboxJobs implements OnModuleInit, OnModuleDestroy {
  private readonly active = new Set<Promise<unknown>>();
  private stopping = false;

  constructor (
    @Inject(OUTBOX_SYMBOLS.processOutbox) private readonly processOutbox: () => Promise<void>,
    @Inject(OUTBOX_SYMBOLS.cleanOutbox) private readonly cleanOutbox: () => Promise<number>,
    @Optional() private readonly scheduler?: SchedulerRegistry
  ) {}

  onModuleInit (): void {
    if (!this.scheduler) throw new Error('Outbox jobs require ScheduleModule.forRoot() in the application');
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'outbox.process', waitForCompletion: true })
  async handleProcess (): Promise<void> {
    await this.run(this.processOutbox);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'outbox.clean', timeZone: 'UTC', waitForCompletion: true })
  async handleCleanup (): Promise<void> {
    await this.run(this.cleanOutbox);
  }

  async onModuleDestroy (): Promise<void> {
    // Nest owns the timers; finish in-flight storage work before resources are closed.
    this.stopping = true;
    await Promise.allSettled(this.active);
  }

  private async run (operation: () => Promise<unknown>): Promise<void> {
    if (this.stopping) return;
    const pending = Promise.resolve().then(operation);
    this.active.add(pending);
    try {
      await pending;
    } finally {
      this.active.delete(pending);
    }
  }
}
