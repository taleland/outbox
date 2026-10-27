export function positiveInteger (value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Outbox ${name} must be a positive safe integer`);
}
