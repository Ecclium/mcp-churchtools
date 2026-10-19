/**
 * The reading ChurchTools client of phase 1 (ADR 0057): `whoami` and
 * `permissions`, each with exactly one request through the transport of
 * its origin, a throttle per client, fixed limits and own schemas.
 *
 * @packageDocumentation
 */
import {
  type Clock,
  EccliumError,
  type Me,
  type Permissions,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type HttpTransport, parseChurchToolsOrigin } from '../http/index.js';
import { createRequestThrottle } from '../throttle/index.js';
import { fetchAnswer, type RequestPath } from './request.js';
import { toPermissions } from './rights.js';
import { whoamiSchema } from './schemas.js';

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
}

const whoamiLimits = Object.freeze({
  maxResponseBytes: 256 * 1024,
  maxElements: 5_000,
});

const permissionsLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxElements: 200_000,
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

  return Object.freeze({ whoami, permissions });
}
