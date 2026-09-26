/**
 * The only way the probes reach the instance.
 *
 * Every request is a GET to the one origin of the base URL. The token goes
 * only into the header `Authorization: Login`, never into a query string,
 * and the probes never ask for a session. Redirects are not followed,
 * because they could carry the token to another host. Each request has a
 * time limit and a size limit, and every header value and every string and
 * number of a response goes onto the block list of the guard at once.
 *
 * Paths come only from fixed templates. An ID taken from a response may
 * fill a template only if it has the form of an ID, and it is encoded.
 *
 * @packageDocumentation
 */
import { SpikeError, type ErrorCode } from './errors.mts';
import type { Guard } from './guard.mts';
import { isObject } from './spec.mts';

/** The fetch function, replaceable in tests. */
export type FetchFunction = (
  input: URL,
  init: RequestInit,
) => Promise<Response>;

/** Whether a request carries the token, none, or a wrong one. */
export type Authorization =
  'token' | 'ohne' | { readonly invalidToken: string };

/** One request of a probe. */
export interface ProbeRequest {
  /** Path from {@link pathFor}, starting with `/`. */
  readonly path: string;
  /** Query parameters in order, arrays written as `name[]`. */
  readonly query?: readonly (readonly [string, string])[];
  /** Default: the token. */
  readonly auth?: Authorization;
  /** Size limit in bytes for this response. */
  readonly maxBytes?: number;
  /**
   * Whether the values of the response go onto the block list. Only the
   * public OpenAPI document of the instance is exempt, see the README.
   */
  readonly blockValues?: boolean;
}

/** What the probes see of a response. */
export interface ProbeResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly setCookies: readonly string[];
  /** Parsed JSON, or `undefined` if the body is empty or no JSON. */
  readonly body: unknown;
  readonly kind: 'JSON' | 'leer' | 'anderes Format';
}

/** A client bound to one instance and one token. */
export interface Client {
  /**
   * Sends one GET request.
   *
   * @param request - Path, query and authorization.
   * @returns The response, already read and parsed.
   * @throws {SpikeError} On network errors, redirects and oversized responses.
   */
  get(request: ProbeRequest): Promise<ProbeResponse>;
}

/** Settings of a client. */
export interface ClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly guard: Guard;
  readonly fetch?: FetchFunction;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** The User-Agent of every request, so the probes are visible in logs. */
export const userAgent = 'ecclium-spike';

const identifier = /^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,199}$/;

/**
 * Fills a fixed path template with IDs.
 *
 * Each `{}` takes the next parameter. A parameter must be a positive whole
 * number or a text of letters, digits and `-_.~`, not starting with a dot,
 * so that it cannot change the path.
 *
 * @param template - Fixed path, such as `/api/wiki/categories/{}/pages`.
 * @param parameters - IDs for the placeholders, in order.
 * @returns The filled path.
 * @throws {SpikeError} If a parameter has another form or the count does not match.
 */
export function pathFor(
  template: string,
  ...parameters: readonly (string | number)[]
): string {
  const parts = template.split('{}');
  if (parts.length !== parameters.length + 1) {
    throw new SpikeError('INTERN');
  }
  return parts.reduce((path, part, index) => {
    if (index === 0) {
      return part;
    }
    const value = parameters[index - 1];
    const valid =
      typeof value === 'number'
        ? Number.isSafeInteger(value) && value > 0
        : value !== undefined && identifier.test(value);
    if (!valid) {
      throw new SpikeError('INTERN');
    }
    return `${path}${encodeURIComponent(String(value))}${part}`;
  }, '');
}

/**
 * Maps a network error to a fixed code.
 *
 * @param error - What fetch threw.
 * @returns The fixed code for this kind of error.
 */
export function classifyNetworkError(error: unknown): ErrorCode {
  const name = isObject(error) ? error['name'] : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'TIMEOUT';
  }
  let code: unknown;
  for (
    let current: unknown = error;
    isObject(current);
    current = current['cause']
  ) {
    if (typeof current['code'] === 'string') {
      code = current['code'];
    }
  }
  if (typeof code !== 'string') {
    return 'NETZ';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'NETZ_DNS';
  }
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code)) {
    return 'NETZ_VERBINDUNG';
  }
  if (/^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) {
    return 'TIMEOUT';
  }
  if (
    /^ERR_(TLS|SSL)|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)
  ) {
    return 'TLS';
  }
  return 'NETZ';
}

async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  // The Node.js types declare the body as a stream of any. A fetch
  // response body is always a byte stream.
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SpikeError('ANTWORT_ZU_GROSS');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function blockCookies(guard: Guard, cookies: readonly string[]): void {
  for (const cookie of cookies) {
    guard.block(cookie);
    for (const part of cookie.split(';')) {
      for (const piece of part.split('=')) {
        guard.block(piece);
      }
    }
  }
}

/**
 * Creates the client for one instance.
 *
 * @param options - Origin, token, guard and limits.
 * @returns A client that sends only the requests described above.
 * @example
 * ```ts
 * const client = createClient({ origin, token, guard });
 * const response = await client.get({ path: pathFor('/api/whoami') });
 * ```
 */
export function createClient(options: ClientOptions): Client {
  const fetchFunction = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  return {
    async get(request: ProbeRequest): Promise<ProbeResponse> {
      const url = new URL(request.path, options.origin);
      if (!request.path.startsWith('/') || url.origin !== options.origin) {
        throw new SpikeError('INTERN');
      }
      for (const [name, value] of request.query ?? []) {
        url.searchParams.append(name, value);
      }
      const headers = new Headers({
        Accept: 'application/json',
        'User-Agent': userAgent,
      });
      const auth = request.auth ?? 'token';
      if (auth === 'token') {
        headers.set('Authorization', `Login ${options.token}`);
      } else if (typeof auth === 'object') {
        headers.set('Authorization', `Login ${auth.invalidToken}`);
      }

      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await fetchFunction(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (
          response.type === 'opaqueredirect' ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel();
          throw new SpikeError('HTTP_REDIRECT');
        }
        bytes = await readLimited(
          response,
          request.maxBytes ?? options.maxBytes ?? 5 * 1024 * 1024,
        );
      } catch (error) {
        throw error instanceof SpikeError
          ? error
          : new SpikeError(classifyNetworkError(error));
      }

      response.headers.forEach((value) => {
        options.guard.block(value);
      });
      const setCookies = response.headers.getSetCookie();
      blockCookies(options.guard, setCookies);

      const text = new TextDecoder().decode(bytes);
      const contentType = response.headers.get('content-type') ?? '';
      let body: unknown = undefined;
      let kind: ProbeResponse['kind'] = 'anderes Format';
      if (text.trim() === '') {
        kind = 'leer';
      } else if (contentType.includes('json')) {
        try {
          body = JSON.parse(text);
          kind = 'JSON';
        } catch {
          kind = 'anderes Format';
        }
      }
      if (request.blockValues !== false) {
        options.guard.blockAll(body);
      }
      return {
        status: response.status,
        headers: response.headers,
        setCookies,
        body,
        kind,
      };
    },
  };
}
