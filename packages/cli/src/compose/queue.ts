/**
 * Whether a server queues writes for the operator (ADR 0031). The first
 * stage of the start over stdio prepares the folder of the queue by it,
 * so that a write that goes to the queue finds it. It loads nothing but
 * types, so that the first stage can import it before the server, its SDK
 * and undici (ADR 0054).
 *
 * @packageDocumentation
 */
import type { EccliumConfig } from '@ecclium/mcp-churchtools-core';

/** A configuration that queues writes, with both folders set. */
export type QueueConfig = EccliumConfig & {
  readonly keysDir: string;
  readonly stateDir: string;
};

/**
 * Asks whether a configuration queues writes: only a server that writes,
 * with a folder of keys for the day keys of the queue and a folder of
 * state for its entries. A server that only reads queues nothing.
 *
 * @param config - The checked configuration.
 * @returns Whether the first stage prepares the folder of the queue.
 * @example
 * ```ts
 * if (keepsQueue(config)) prepareQueueFolder(config.stateDir);
 * ```
 */
export function keepsQueue(config: EccliumConfig): config is QueueConfig {
  return (
    !config.readOnly &&
    config.keysDir !== undefined &&
    config.stateDir !== undefined
  );
}
