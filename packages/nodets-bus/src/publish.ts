import { type BusInstance } from '@node-ts/bus-core';
import { type Publish } from '@taleland/outbox-core';

/** A GetBus provider or an application-owned resolver of initialized bus instances. */
export type GetNodeTsBus = (busToken: string) => Pick<BusInstance, 'publish'>;

/** Persist these adapter-specific fields with the event, so retries keep the same routing. */
export interface NodeTsOutboxMetadata extends Readonly<Record<string, unknown>> {
  readonly busToken: string;
  readonly eventName: string;
  readonly eventVersion: number;
}

export function createNodeTsPublish (getBus: GetNodeTsBus): Publish {
  return async (payload, { metadata, outboxId }) => {
    const { busToken, eventName, eventVersion } = metadata;
    if (typeof busToken !== 'string' || !busToken.trim()) {
      throw new TypeError('Outbox node-ts metadata.busToken must be a nonempty string');
    }
    if (typeof eventName !== 'string' || !eventName.trim()) {
      throw new TypeError('Outbox node-ts metadata.eventName must be a nonempty string');
    }
    if (typeof eventVersion !== 'number' || !Number.isSafeInteger(eventVersion) || eventVersion < 0) {
      throw new TypeError('Outbox node-ts metadata.eventVersion must be a nonnegative safe integer');
    }
    await getBus(busToken).publish({ ...payload, $name: eventName, $version: eventVersion }, {
      attributes: { outboxId },
    });
  };
}
