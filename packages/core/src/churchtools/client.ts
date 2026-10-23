/**
 * The reading ChurchTools client of phase 1 (ADR 0057): `whoami`,
 * `permissions` and the searches of persons and groups by name (ADR 0060),
 * each with exactly one request through the transport of its origin, a
 * throttle per client, fixed limits and own schemas.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  EccliumError,
  type GroupHit,
  maxSearchHits,
  maxSearchTermLength,
  type Me,
  normalizeSearchTerm,
  type Permissions,
  type PersonHit,
  type SearchHits,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type HttpTransport, parseChurchToolsOrigin } from '../http/index.js';
import { createRequestThrottle } from '../throttle/index.js';
import { appendPage } from './query.js';
import { fetchAnswer, type RequestPath } from './request.js';
import { toPermissions } from './rights.js';
import {
  groupListSchema,
  personListSchema,
  searchPageLimit,
  whoamiSchema,
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

  return Object.freeze({ whoami, permissions, searchPersons, searchGroups });
}
