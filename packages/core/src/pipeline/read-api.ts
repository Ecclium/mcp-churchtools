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
  type Sensitivity,
  type TenantContext,
  type WikiCategories,
  type WikiPage,
  type WikiPageList,
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
 * @param sensitivity - The sensitivity of the calling tool. Only `special`
 *   may search persons and groups; any other gets `policy_denied`.
 * @returns The access, frozen and without prototype.
 * @example
 * ```ts
 * const access = createReadAccess(client, ctx, entry.meta.sensitivity);
 * try { await tool.execute({ ctx, input, read: access.read }); }
 * finally { access.revoke(); }
 * ```
 */
export function createReadAccess(
  client: ChurchToolsClient,
  ctx: TenantContext,
  sensitivity: Sensitivity,
): ReadAccess {
  let revoked = false;
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    revoked ? Promise.reject(new EccliumError('internal')) : run();
  // Persons and groups reveal religious affiliation. Only a tool of the
  // sensitivity special may search them: only its result waits for its
  // line in the audit file, and only it never runs unattended (ADR 0028,
  // ADR 0060). A tool that declares less could otherwise pass on names
  // without either.
  const special = <T>(run: () => Promise<T>): Promise<T> => {
    if (revoked || sensitivity === 'special') return guard(run);
    ctx.log.warn('read_search_refused', { code: 'policy_denied' });
    return Promise.reject(new EccliumError('policy_denied'));
  };
  const read: ReadApi = Object.freeze({
    __proto__: null,
    whoami: (): Promise<Me> => guard(() => client.whoami(ctx)),
    permissions: (): Promise<Permissions> =>
      guard(() => client.permissions(ctx)),
    searchPersons: (query: string): Promise<SearchHits<PersonHit>> =>
      special(() => client.searchPersons(ctx, query)),
    searchGroups: (query: string): Promise<SearchHits<GroupHit>> =>
      special(() => client.searchGroups(ctx, query)),
    wikiCategories: (): Promise<WikiCategories> =>
      guard(() => client.wikiCategories(ctx)),
    wikiPages: (categoryId: number, page: number): Promise<WikiPageList> =>
      guard(() => client.wikiPages(ctx, categoryId, page)),
    wikiPage: (
      categoryId: number,
      guid: string,
      version?: number,
    ): Promise<WikiPage> =>
      guard(() => client.wikiPage(ctx, categoryId, guid, version)),
  });
  return Object.freeze({
    __proto__: null,
    read,
    revoke: (): void => {
      revoked = true;
    },
  });
}
