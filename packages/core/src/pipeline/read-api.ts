/**
 * Read access to ChurchTools for one call of a tool (ADR 0024). It reads
 * through the raw client with the context of the call, so a tool never
 * sees a token and cannot choose the host. The pipeline revokes it when the
 * call ends; every method then rejects, also for a tool that kept it.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type GroupHit,
  type Me,
  type Permissions,
  type PersonHit,
  type ReadApi,
  type SearchHits,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsClient } from '../churchtools/index.js';

/** Read access of one call and the way to end it. */
export interface ReadAccess {
  /** What the tool receives as `read`. */
  readonly read: ReadApi;
  /** Ends the access. Every later call of a method rejects. */
  revoke(): void;
}

/**
 * Makes the read access of one call.
 *
 * @param client - The raw client of the instance.
 * @param ctx - The context of the call. Its signal aborts every request.
 * @returns The access, frozen and without prototype.
 * @example
 * ```ts
 * const access = createReadAccess(client, ctx);
 * try { await tool.execute({ ctx, input, read: access.read }); }
 * finally { access.revoke(); }
 * ```
 */
export function createReadAccess(
  client: ChurchToolsClient,
  ctx: TenantContext,
): ReadAccess {
  let revoked = false;
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    revoked ? Promise.reject(new EccliumError('internal')) : run();
  const read: ReadApi = Object.freeze({
    __proto__: null,
    whoami: (): Promise<Me> => guard(() => client.whoami(ctx)),
    permissions: (): Promise<Permissions> =>
      guard(() => client.permissions(ctx)),
    searchPersons: (query: string): Promise<SearchHits<PersonHit>> =>
      guard(() => client.searchPersons(ctx, query)),
    searchGroups: (query: string): Promise<SearchHits<GroupHit>> =>
      guard(() => client.searchGroups(ctx, query)),
  });
  return Object.freeze({
    __proto__: null,
    read,
    revoke: (): void => {
      revoked = true;
    },
  });
}
