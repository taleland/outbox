import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { type OutboxModuleOptions } from './options.js';
import { OUTBOX_OPTIONS, OUTBOX_SYMBOLS } from './symbols.js';

@Injectable()
export class OutboxJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxJobs.name);
  private readonly jobs = new Map<string, CronJob>();
  private stopping = false;

  constructor (
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxModuleOptions,
    @Inject(OUTBOX_SYMBOLS.processOutbox) private readonly processOutbox: () => Promise<void>,
    @Inject(OUTBOX_SYMBOLS.cleanOutbox) private readonly cleanOutbox: () => Promise<number>,
    @Optional() private readonly scheduler?: SchedulerRegistry
  ) {}

  onApplicationBootstrap (): void {
    if (!this.options.jobs) return;
    const definitions = [
      { name: 'outbox.process', options: this.options.jobs.process, cron: '* * * * * *', run: this.processOutbox },
      { name: 'outbox.clean', options: this.options.jobs.clean, cron: '0 0 0 * * *', run: this.cleanOutbox },
    ];
    const enabled = definitions.filter(definition => definition.options !== false);
    if (enabled.length === 0) return;
    const scheduler = this.scheduler;
    if (!scheduler) throw new Error('Outbox jobs require ScheduleModule.forRoot() in the application');
    // Validate every schedule before registering or starting any timers.
    const pending = enabled.map(definition => {
      if (scheduler.doesExist('cron', definition.name)) {
        throw new Error(`Cron job ${definition.name} already exists; register OutboxModule once per application`);
      }
      const options = definition.options || {};
      const job = CronJob.from({
        cronTime: options.cron ?? definition.cron,
        timeZone: options.timeZone ?? 'UTC',
        waitForCompletion: true,
        start: false,
        onTick: async () => {
          if (!this.stopping) await definition.run();
        },
        errorHandler: error => this.logger.error(`Scheduled ${definition.name} failed`, error),
      });
      return { name: definition.name, job };
    });
    for (const { name, job } of pending) {
      scheduler.addCronJob(name, job);
      this.jobs.set(name, job);
    }
    for (const job of this.jobs.values()) job.start();
  }

  async onModuleDestroy (): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.jobs.values()].map(async job => await job.stop()));
    for (const name of this.jobs.keys()) {
      if (this.scheduler?.doesExist('cron', name)) this.scheduler.deleteCronJob(name);
    }
    this.jobs.clear();
  }
}
