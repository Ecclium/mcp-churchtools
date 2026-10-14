/**
 * The clock of the system, which the composition root hands to the logger,
 * the audit and the tools (ADR 0054).
 *
 * @packageDocumentation
 */
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The time of the system. Frozen, so that no module can replace its method
 * for every other module. Tests pass a fake clock instead.
 */
export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
});
