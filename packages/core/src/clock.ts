/**
 * The clock of the system, which the composition root hands to the logger,
 * the audit and the tools (ADR 0054).
 *
 * @packageDocumentation
 */
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The time of the system. Frozen, method and all, so that no module can
 * replace the method or hang a value on it for every other module that
 * shares the clock. Tests pass a fake clock instead.
 */
export const systemClock: Clock = Object.freeze({
  now: Object.freeze((): number => Date.now()),
});
