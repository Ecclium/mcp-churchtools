/**
 * Who reads in a run of a routine and under which ID (ADR 0033): a run of
 * its own, drawn by the core, and the actor of the routine, `runner:<ID>`,
 * in the tenant of self-hosting.
 *
 * Where it stands in a run: at its start, in the composition root, which
 * alone sets actor and mode of a run. The engine gets a port to read that
 * carries both and never builds either.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';

import type {
  RunId,
  TenantAssignment,
} from '@ecclium/mcp-churchtools-plugin-api';

import { defaultTenantId, toTenantId } from '../tenant/tenant-id.js';

// The ID of a routine, as the policy names it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Draws the ID of a new run, a random UUID. Only the core makes one.
 *
 * @returns The ID.
 * @example
 * ```ts
 * const runId = createRunId();
 * ```
 */
export function createRunId(): RunId {
  return randomUUID() as RunId;
}

/**
 * The tenant and the actor of the runs of a routine: the tenant of
 * self-hosting and the actor `runner:<ID>`, so that every routine has a
 * read budget and an audit trail of its own (ADR 0033, ADR 0063).
 *
 * @param routineId - The ID of the routine, as the policy names it.
 * @returns Tenant and actor, frozen.
 * @throws {TypeError} For an ID of another form.
 * @example
 * ```ts
 * runAssignmentOf('dienstplan-report');
 * // { tenantId: 'default', actor: { kind: 'runner', id: 'runner:dienstplan-report' } }
 * ```
 */
export function runAssignmentOf(routineId: string): TenantAssignment {
  if (typeof routineId !== 'string' || !routinePattern.test(routineId)) {
    throw new TypeError('The ID of the routine is invalid.');
  }
  return Object.freeze({
    tenantId: toTenantId(defaultTenantId) as TenantAssignment['tenantId'],
    actor: Object.freeze({ kind: 'runner', id: `runner:${routineId}` }),
  });
}
