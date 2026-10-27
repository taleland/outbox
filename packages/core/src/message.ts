export type OutboxState = 'PENDING' | 'PROCESSED' | 'DELIVERED' | 'FAILED';

export class OutboxMessage {
  id!: string;
  payload!: object;
  metadata!: Record<string, unknown>;
  state: OutboxState = 'PENDING';
  retries = 0;
  createdAt!: Date;
  updatedAt!: Date;
  nextAttemptAt!: Date;
  deletedAt: Date | null = null;

  process (): void {
    if (this.state !== 'PENDING' && this.state !== 'FAILED') throw new Error('Outbox state conflict');
    if (this.state === 'FAILED') this.retries += 1;
    this.state = 'PROCESSED';
  }

  delivery (): void {
    if (this.state !== 'PROCESSED') throw new Error('Outbox state conflict');
    this.state = 'DELIVERED';
  }

  fail (): void {
    if (this.state !== 'PROCESSED') throw new Error('Outbox state conflict');
    this.state = 'FAILED';
  }
}
