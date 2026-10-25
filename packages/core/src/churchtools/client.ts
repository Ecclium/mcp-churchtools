/**
 * The reading ChurchTools client (ADR 0057): `whoami`, `permissions`, the
 * searches of persons and groups by name (ADR 0060), one person, the
 * groups of a person, one group and its members (ADR 0064) and the wiki,
 * each with exactly one request through the transport of its origin, a
 * throttle per client, fixed limits and own schemas.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  EccliumError,
  type Group,
  type GroupHit,
  type GroupMemberList,
  groupMembersPageLimit,
  isWikiPageGuid,
  maxGroupMembersPage,
  maxPersonGroups,
  maxSearchHits,
  maxSearchTermLength,
  maxWikiListPage,
  type Me,
  normalizeSearchTerm,
  type Permissions,
  type Person,
  type PersonGroupList,
  type PersonHit,
  type SearchHits,
  type TenantContext,
  type WikiCategory,
  wikiPageListLimit,
  type WikiPage,
  type WikiPageList,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type HttpTransport, parseChurchToolsOrigin } from '../http/index.js';
import { createRequestThrottle } from '../throttle/index.js';
import { appendIds, appendPage, urlOfPath } from './query.js';
import { fetchAnswer, type RequestPath } from './request.js';
import { toPermissions } from './rights.js';
import {
  groupListSchema,
  groupMemberListSchema,
  groupSchema,
  personGroupListSchema,
  personListSchema,
  personSchema,
  searchPageLimit,
  whoamiSchema,
  wikiCategoryListSchema,
  wikiPageListSchema,
  wikiPageSchema,
} from './schemas.js';

/** What a client is built from. */
export interface ChurchToolsClientOptions {
  /** The transport of the origin, built by the composition root. */
  readonly transport: HttpTransport;
  /** The canonical origin of the instance, the same as the transport's. */
  readonly origin: string;
  /** Requests per minute, from the configuration. */
  readonly requestsPerMinute: number;
  /** The clock of the throttle. */
  readonly clock: Clock;
}

/** The reading client of one ChurchTools instance. */
export interface ChurchToolsClient {
  /**
   * Reads the account of the server, only if ChurchTools accepted the token.
   *
   * @throws {EccliumError} `auth` for an anonymous answer, and every error of
   *   the request.
   */
  whoami(ctx: TenantContext): Promise<Me>;
  /**
   * Reads the rights of the account of the server. It proves no sign-in;
   * only `whoami` does.
   *
   * @throws {EccliumError} Every error of the request.
   */
  permissions(ctx: TenantContext): Promise<Permissions>;
  /**
   * Searches persons by name with `GET /api/persons`, sending only `query`,
   * `page=1` and `limit=51` (ADR 0060).
   *
   * @throws {EccliumError} `validation` for a term that is not a search
   *   term, before the throttle and any request; `upstream` for an entry
   *   without ID or name, or more than 51 entries; every error of the
   *   request.
   */
  searchPersons(
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<PersonHit>>;
  /**
   * Searches groups by name with `GET /api/groups`, sending only `query`,
   * `page=1` and `limit=51` (ADR 0060).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.searchPersons}.
   */
  searchGroups(
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<GroupHit>>;
  /**
   * Reads one person with `GET /api/persons/{personId}`, by its numeric ID
   * only (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before the throttle and any request; `permission` for 403;
   *   `not_found` for 404; `upstream` for an answer without the four
   *   fields; every error of the request.
   */
  person(ctx: TenantContext, personId: number): Promise<Person>;
  /**
   * Reads the groups of one person with `GET /api/persons/{personId}/groups`,
   * without any parameter (ADR 0064).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.person}, and
   *   `upstream` for more than 1000 groups.
   */
  personGroups(ctx: TenantContext, personId: number): Promise<PersonGroupList>;
  /**
   * Reads one group with `GET /api/groups/{groupId}`, by its numeric ID
   * only (ADR 0064).
   *
   * @throws {EccliumError} As {@link ChurchToolsClient.person}, and
   *   `upstream` for a part of the details of the lowest level.
   */
  group(ctx: TenantContext, groupId: number): Promise<Group>;
  /**
   * Reads one page of the members of a group with
   * `GET /api/groups/{groupId}/members`, sending only `page` and
   * `limit=50`, never `personFields[]` or `include` (ADR 0064).
   *
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1 or a page outside 1 to 1000, before the throttle and any
   *   request; otherwise as {@link ChurchToolsClient.person}.
   */
  groupMembers(
    ctx: TenantContext,
    groupId: number,
    page: number,
  ): Promise<GroupMemberList>;
  /**
   * Lists the categories of the wiki with `GET /api/wiki/categories`, all
   * of them from the one answer.
   *
   * @throws {EccliumError} `upstream` for a category without ID or name,
   *   or more than 1000; every error of the request.
   */
  wikiCategories(ctx: TenantContext): Promise<readonly WikiCategory[]>;
  /**
   * Lists one page of the pages of a category with `GET /api/wiki/pages`,
   * sending only the category in `wiki_category_ids[]`, `page` and
   * `limit=25`.
   *
   * @throws {EccliumError} `validation` for an ID or page that is no whole
   *   number from 1, before the throttle and any request; `upstream` for
   *   an entry that does not fit; every error of the request.
   */
  wikiPages(
    ctx: TenantContext,
    categoryId: number,
    page: number,
  ): Promise<WikiPageList>;
  /**
   * Reads one page of the wiki by its GUID, in its newest version or, with
   * `version`, in exactly that one. F19 shows the route of one version for
   * the newest version of a page; an older one is not yet shown.
   *
   * @throws {EccliumError} `validation` for an ID, GUID or version that does
   *   not fit, before the throttle and any request; `not_found` for a page
   *   or version that does not exist; `upstream` for an answer that does
   *   not fit, also another version than asked for; every error of the
   *   request.
   */
  wikiPage(
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    version?: number,
  ): Promise<WikiPage>;
}

const whoamiLimits = Object.freeze({
  maxResponseBytes: 256 * 1024,
  maxElements: 5_000,
});

const permissionsLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 200_000,
});

// A search reads 51 entries. The limits fit them in the form of the highest
// security level, with every field of a person or a group: an account with
// more rights than the search needs still gets its hits, and the client
// drops the other fields (ADR 0060).
const searchLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 100_000,
});

// One person or one group, in the form of the highest security level with
// every field, and a group with many roles: an account with more rights
// than the read needs still gets its answer, and the client drops the
// other fields (ADR 0064).
const objectLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 20_000,
});

// Each membership carries objects of the group and the person with about
// 50 fields; the limits fit 1000 groups of a person with them.
const personGroupsLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 200_000,
});

// One page of 50 members, each with the objects of its group and person,
// also with fields a request with personFields[] would add.
const groupMembersLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 50_000,
});

// Each entry of the list of pages carries objects of the persons who
// created and last changed the page, which the client drops. The limits
// fit 1000 categories and 25 pages with them.
const wikiListLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 100_000,
});

// A page carries its whole text; a tool passes it on in parts.
const wikiPageLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  maxElements: 20_000,
});

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidWikiInput = `A category ID and a version are whole numbers from 1, a page of the list is a whole number from 1 to ${String(maxWikiListPage)}, and a wiki page is addressed by its GUID.`;

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidReadInput = `A person ID and a group ID are whole numbers from 1, and a page of the members of a group is a whole number from 1 to ${String(maxGroupMembersPage)}.`;

// The identifier of a group in a membership, a text such as "12". Only a
// whole number from 1 in its plain form counts as the ID of the group.
const groupIdentifier = /^[1-9][0-9]{0,15}$/;

const groupIdOf = (identifier: string): number | null => {
  if (!groupIdentifier.test(identifier)) return null;
  const value = Number(identifier);
  return Number.isSafeInteger(value) ? value : null;
};

// In English for the model; printable ASCII, like every message (ADR 0054).
const invalidTerm = `The search term needs 1 to ${String(maxSearchTermLength)} characters after removing spaces at both ends, and no control characters.`;

/** The fixed events of one search. */
interface SearchEvents {
  /** A term that is not a search term. */
  readonly term: string;
  /** An answer with a status other than 200. */
  readonly status: string;
  /** An answer with status 200 that is not read. */
  readonly refused: string;
}

const personEvents: SearchEvents = Object.freeze({
  term: 'churchtools_persons_term_refused',
  status: 'churchtools_persons_status',
  refused: 'churchtools_persons_refused',
});

const groupEvents: SearchEvents = Object.freeze({
  term: 'churchtools_groups_term_refused',
  status: 'churchtools_groups_status',
  refused: 'churchtools_groups_refused',
});

// The hits of a search: at most maxSearchHits, and whether a further
// visible entry came. Frozen, without prototype, built from the read
// fields only.
const toHits = <Hit>(entries: readonly Hit[]): SearchHits<Hit> =>
  Object.freeze({
    __proto__: null,
    hits: Object.freeze(entries.slice(0, maxSearchHits)),
    more: entries.length > maxSearchHits,
  });

const isWholeFromOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Builds the client of one origin. Exactly one client exists per origin, so
 * that all its requests share one throttle.
 *
 * @param options - Transport, origin, rate and clock.
 * @returns The client, frozen. Its only state is the throttle.
 * @throws {TypeError} When the origin is not canonical or the rate is not
 *   a whole number from 1.
 * @example
 * ```ts
 * const client = createChurchToolsClient({ transport, origin, requestsPerMinute: 300, clock });
 * const me = await client.whoami(ctx);
 * ```
 */
export function createChurchToolsClient(
  options: ChurchToolsClientOptions,
): ChurchToolsClient {
  const { transport, origin, requestsPerMinute, clock } = options;
  const checked = parseChurchToolsOrigin(origin);
  if (!checked.ok || checked.origin !== origin) {
    throw new TypeError('The origin of a client must be canonical.');
  }
  const path: RequestPath = Object.freeze({
    origin,
    transport,
    throttle: createRequestThrottle({ requestsPerMinute, clock }),
  });

  const whoami = async (ctx: TenantContext): Promise<Me> => {
    const url = new URL('/api/whoami', origin);
    url.searchParams.append('only_allow_authenticated', 'true');
    const root = await fetchAnswer(ctx, path, url, whoamiLimits, {
      status: 'churchtools_whoami_status',
      refused: 'churchtools_whoami_refused',
    });
    // The anonymous person first: its answer is not known beyond guid and
    // firstName, so the full schema would refuse it as upstream.
    const data = root.data;
    if (!isPlain(data)) {
      ctx.log.warn('churchtools_whoami_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const meta = root.meta;
    const simulating =
      isPlain(meta) &&
      Object.hasOwn(meta, 'simulatingUserId') &&
      meta.simulatingUserId !== null &&
      meta.simulatingUserId !== undefined;
    if (data.guid === '' || simulating) {
      ctx.log.warn('churchtools_whoami_anonymous', { code: 'auth' });
      throw new EccliumError('auth');
    }
    const parsed = whoamiSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_whoami_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const person = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      email:
        person.email === undefined ||
        person.email === null ||
        person.email === ''
          ? null
          : person.email,
    });
  };

  const permissions = async (ctx: TenantContext): Promise<Permissions> => {
    const url = new URL('/api/permissions/global', origin);
    const root = await fetchAnswer(ctx, path, url, permissionsLimits, {
      status: 'churchtools_permissions_status',
      refused: 'churchtools_permissions_refused',
    });
    const result = toPermissions(root.data);
    if (result.kind === 'unknown') {
      ctx.log.warn('churchtools_permissions_unknown', {});
    }
    return result;
  };

  // Sends one search and returns the root of its answer. The term is
  // checked before the throttle gives a place: an invalid one costs no
  // request and no place. Exactly query, page and limit go out, nothing a
  // caller chooses beyond the term (ADR 0060).
  const fetchSearch = async (
    ctx: TenantContext,
    pathname: '/api/persons' | '/api/groups',
    query: unknown,
    events: SearchEvents,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const term = normalizeSearchTerm(query);
    if (term === undefined) {
      ctx.log.warn(events.term, { code: 'validation' });
      throw new EccliumError('validation', invalidTerm);
    }
    const url = new URL(pathname, origin);
    url.searchParams.append('query', term);
    appendPage(url.searchParams, 1, searchPageLimit);
    return fetchAnswer(ctx, path, url, searchLimits, events);
  };

  const searchPersons = async (
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<PersonHit>> => {
    const root = await fetchSearch(ctx, '/api/persons', query, personEvents);
    const parsed = personListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn(personEvents.refused, { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return toHits(
      parsed.data.data.map((entry): PersonHit =>
        Object.freeze({
          __proto__: null,
          id: entry.id,
          firstName: entry.firstName,
          lastName: entry.lastName,
        }),
      ),
    );
  };

  const searchGroups = async (
    ctx: TenantContext,
    query: string,
  ): Promise<SearchHits<GroupHit>> => {
    const root = await fetchSearch(ctx, '/api/groups', query, groupEvents);
    const parsed = groupListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn(groupEvents.refused, { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return toHits(
      parsed.data.data.map((entry): GroupHit =>
        Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
      ),
    );
  };

  // Refuses an ID or page that may not fill a path or a query before the
  // throttle gives a place, so that an invalid value costs no request.
  // Only a checked whole number fills a path, and the built URL must keep
  // exactly that path (ADR 0057).
  const checkReadInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_read_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidReadInput);
  };

  const person = async (
    ctx: TenantContext,
    personId: number,
  ): Promise<Person> => {
    checkReadInput(ctx, isWholeFromOne(personId));
    const url = urlOfPath(origin, `/api/persons/${String(personId)}`);
    const root = await fetchAnswer(ctx, path, url, objectLimits, {
      status: 'churchtools_person_status',
      refused: 'churchtools_person_refused',
      missing: 'churchtools_person_missing',
    });
    const parsed = personSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_person_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      id: data.id,
      firstName: data.firstName,
      lastName: data.lastName,
      isArchived: data.isArchived,
    });
  };

  const personGroups = async (
    ctx: TenantContext,
    personId: number,
  ): Promise<PersonGroupList> => {
    checkReadInput(ctx, isWholeFromOne(personId));
    // Without show_overdue_groups and the other switches, so the list holds
    // what ChurchTools shows without them (ADR 0064).
    const url = urlOfPath(origin, `/api/persons/${String(personId)}/groups`);
    const root = await fetchAnswer(ctx, path, url, personGroupsLimits, {
      status: 'churchtools_person_groups_status',
      refused: 'churchtools_person_groups_refused',
      missing: 'churchtools_person_groups_missing',
    });
    const parsed = personGroupListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_person_groups_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const entries = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      groups: Object.freeze(
        entries.slice(0, maxPersonGroups).map((entry) =>
          Object.freeze({
            __proto__: null,
            groupId: groupIdOf(entry.group.domainIdentifier),
            groupName: entry.group.title,
            groupTypeRoleId: entry.groupTypeRoleId,
            groupMemberStatus: entry.groupMemberStatus,
          }),
        ),
      ),
      more: entries.length > maxPersonGroups,
    });
  };

  const group = async (ctx: TenantContext, groupId: number): Promise<Group> => {
    checkReadInput(ctx, isWholeFromOne(groupId));
    const url = urlOfPath(origin, `/api/groups/${String(groupId)}`);
    const root = await fetchAnswer(ctx, path, url, objectLimits, {
      status: 'churchtools_group_status',
      refused: 'churchtools_group_refused',
      missing: 'churchtools_group_missing',
    });
    const parsed = groupSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_group_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    const details = data.information;
    // The schema takes the details all together or not at all, so one
    // missing field means none came.
    return Object.freeze({
      __proto__: null,
      id: data.id,
      name: data.name,
      details:
        details.meetingTime === undefined
          ? null
          : Object.freeze({
              __proto__: null,
              meetingTime: details.meetingTime,
              note: details.note ?? null,
              maxMembers: details.maxMembers ?? null,
              targetGroupId: details.targetGroupId ?? null,
              dateOfFoundation: details.dateOfFoundation ?? null,
              endDate: details.endDate ?? null,
            }),
    });
  };

  const groupMembers = async (
    ctx: TenantContext,
    groupId: number,
    page: number,
  ): Promise<GroupMemberList> => {
    checkReadInput(
      ctx,
      isWholeFromOne(groupId) &&
        isWholeFromOne(page) &&
        page <= maxGroupMembersPage,
    );
    const url = urlOfPath(origin, `/api/groups/${String(groupId)}/members`);
    appendPage(url.searchParams, page, groupMembersPageLimit);
    const root = await fetchAnswer(ctx, path, url, groupMembersLimits, {
      status: 'churchtools_group_members_status',
      refused: 'churchtools_group_members_refused',
      missing: 'churchtools_group_members_missing',
    });
    const parsed = groupMemberListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_group_members_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      members: Object.freeze(
        parsed.data.data.map((entry) =>
          Object.freeze({
            __proto__: null,
            personId: entry.personId,
            firstName: entry.person.domainAttributes.firstName,
            lastName: entry.person.domainAttributes.lastName,
            groupTypeRoleId: entry.groupTypeRoleId,
            groupMemberStatus: entry.groupMemberStatus,
          }),
        ),
      ),
      more: page < parsed.data.meta.pagination.lastPage,
    });
  };

  // Refuses what may not fill a path or a query before the throttle gives
  // a place, so that an invalid value costs no request.
  const checkWikiInput = (ctx: TenantContext, valid: boolean): void => {
    if (valid) return;
    ctx.log.warn('churchtools_wiki_input_refused', { code: 'validation' });
    throw new EccliumError('validation', invalidWikiInput);
  };

  const wikiCategories = async (
    ctx: TenantContext,
  ): Promise<readonly WikiCategory[]> => {
    const url = new URL('/api/wiki/categories', origin);
    const root = await fetchAnswer(ctx, path, url, wikiListLimits, {
      status: 'churchtools_wiki_categories_status',
      refused: 'churchtools_wiki_categories_refused',
    });
    const parsed = wikiCategoryListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_wiki_categories_refused', {
        code: 'upstream',
      });
      throw new EccliumError('upstream');
    }
    return Object.freeze(
      parsed.data.data.map((entry) =>
        Object.freeze({ __proto__: null, id: entry.id, name: entry.name }),
      ),
    );
  };

  const wikiPages = async (
    ctx: TenantContext,
    categoryId: number,
    page: number,
  ): Promise<WikiPageList> => {
    checkWikiInput(
      ctx,
      isWholeFromOne(categoryId) &&
        isWholeFromOne(page) &&
        page <= maxWikiListPage,
    );
    const url = new URL('/api/wiki/pages', origin);
    appendIds(url.searchParams, 'wiki_category_ids[]', [categoryId]);
    appendPage(url.searchParams, page, wikiPageListLimit);
    const root = await fetchAnswer(ctx, path, url, wikiListLimits, {
      status: 'churchtools_wiki_pages_status',
      refused: 'churchtools_wiki_pages_refused',
    });
    const parsed = wikiPageListSchema.safeParse(root);
    if (!parsed.success) {
      ctx.log.warn('churchtools_wiki_pages_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    return Object.freeze({
      __proto__: null,
      pages: Object.freeze(
        parsed.data.data.map((entry) =>
          Object.freeze({
            __proto__: null,
            guid: entry.guid,
            title: entry.title,
            isMarkdown: entry.isMarkdown,
            version: entry.version,
          }),
        ),
      ),
      more: page < parsed.data.meta.pagination.lastPage,
    });
  };

  const wikiPage = async (
    ctx: TenantContext,
    categoryId: number,
    guid: string,
    version?: number,
  ): Promise<WikiPage> => {
    checkWikiInput(
      ctx,
      isWholeFromOne(categoryId) &&
        isWikiPageGuid(guid) &&
        (version === undefined || isWholeFromOne(version)),
    );
    // Only checked values fill the path: a whole number, a GUID and, for
    // one version, a whole number. The built URL must have exactly that
    // path and no query (ADR 0057).
    const page = `/api/wiki/categories/${String(categoryId)}/pages/${guid}`;
    const pathname =
      version === undefined ? page : `${page}/versions/${String(version)}`;
    const url = urlOfPath(origin, pathname);
    const root = await fetchAnswer(ctx, path, url, wikiPageLimits, {
      status: 'churchtools_wiki_page_status',
      refused: 'churchtools_wiki_page_refused',
      missing: 'churchtools_wiki_page_missing',
    });
    const parsed = wikiPageSchema.safeParse(root);
    if (
      !parsed.success ||
      (version !== undefined && parsed.data.data.version !== version)
    ) {
      ctx.log.warn('churchtools_wiki_page_refused', { code: 'upstream' });
      throw new EccliumError('upstream');
    }
    const data = parsed.data.data;
    return Object.freeze({
      __proto__: null,
      guid,
      title: data.title,
      isMarkdown: data.isMarkdown,
      version: data.version,
      text: data.text ?? '',
    });
  };

  return Object.freeze({
    whoami,
    permissions,
    searchPersons,
    searchGroups,
    person,
    personGroups,
    group,
    groupMembers,
    wikiCategories,
    wikiPages,
    wikiPage,
  });
}
