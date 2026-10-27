export const OUTBOX_SYMBOLS = {
  create: Symbol('outbox.create'),
  withOutbox: Symbol('outbox.withOutbox'),
  processOutbox: Symbol('outbox.processOutbox'),
  cleanOutbox: Symbol('outbox.cleanOutbox'),
} as const;

export const OUTBOX_OPTIONS = Symbol('outbox.options');
