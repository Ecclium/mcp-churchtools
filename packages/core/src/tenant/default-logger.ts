/**
 * A logger bound to the tenant `default`, the tenant of self-hosting and
 * the only one over stdio (ADR 0003). The composition root hands it to the
 * transport, whose lines then name the same tenant as the lines and the
 * audit of a call, without a way to make a tenant of its own.
 *
 * @packageDocumentation
 */
import type { Logger } from '@ecclium/mcp-churchtools-plugin-api';

import { createLogger, type LoggerOptions } from '../logger/index.js';
import { defaultTenantId, toTenantId } from './tenant-id.js';

/**
 * Creates a logger whose every line carries the tenant `default` in
 * `tenantId`. A call cannot set another tenant: the logger drops and counts
 * the field like every bound one.
 *
 * @param options - Writer, clock and lowest level, as for the logger.
 * @returns The logger, frozen.
 * @throws {TypeError} If an option is not valid, with a fixed message.
 * @example
 * ```ts
 * const logger = createDefaultTenantLogger({ writer, clock: systemClock,
 *   minLevel: 'info' });
 * const transport = createHttpTransport({ origin, token, userAgent, logger,
 *   clock: systemClock });
 * ```
 */
export function createDefaultTenantLogger(
  options: Omit<LoggerOptions, 'bound'>,
): Logger {
  return createLogger({
    writer: options.writer,
    clock: options.clock,
    minLevel: options.minLevel,
    bound: { tenantId: toTenantId(defaultTenantId) },
  });
}
