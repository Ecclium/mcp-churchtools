/**
 * Makes a {@link TenantId} from a checked string (ADR 0003). Only the core
 * makes a tenant, through the resolver and the factory of the context, so
 * no entry of core exports this module.
 *
 * @packageDocumentation
 */
import type { TenantId } from '@ecclium/mcp-churchtools-plugin-api';

import { auditPlaceholders } from '../audit/index.js';
import { isTenantId } from '../logger/index.js';

/** The tenant of self-hosting, the only one over stdio (ADR 0003). */
export const defaultTenantId = 'default';

/**
 * Gives the tenant for a value that fits the pattern of a tenant, or
 * undefined. The placeholder of the audit fits the pattern but is refused,
 * so that no reader of the audit takes it for a real tenant (ADR 0054).
 *
 * @param value - Any value.
 * @returns The tenant, or undefined.
 */
export const toTenantId = (value: unknown): TenantId | undefined =>
  isTenantId(value) && value !== auditPlaceholders.tenantId
    ? (value as TenantId)
    : undefined;
