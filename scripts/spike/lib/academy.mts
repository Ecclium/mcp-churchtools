/**
 * The client for the public help pages of ChurchTools, the academy.
 *
 * The academy is the public documentation site of the vendor of
 * ChurchTools. Its host is fixed here, and it is the only host besides the
 * instance that a probe reaches (ADR 0027). The client takes no token and
 * has no way to send one: it sets no `Authorization` header and sends no
 * cookie. It sends only GET to a few fixed paths with a few fixed query
 * parameters, follows no redirect, has a time limit and a size limit, and
 * waits between two requests, longer if `robots.txt` asks for it.
 *
 * It returns the body as text as well, because `robots.txt` and a help page
 * are no JSON. The values of the academy are public and do not come from
 * the instance, so they do not go onto the block list of the guard.
 *
 * @packageDocumentation
 */
import { SpikeError } from './errors.mts';
import {
  classifyNetworkError,
  isPlainPath,
  readLimited,
  userAgent,
  type FetchFunction,
} from './http.mts';

/** The public host of the academy, the one host besides the instance. */
export const academyOrigin = 'https://churchtools.academy';

/** The least pause between two requests to the academy, in milliseconds. */
export const academyPauseMs = 3000;

/**
 * The longest pause a `Crawl-delay` in `robots.txt` may ask for, in
 * milliseconds. A longer one ends the reading of the academy instead.
 */
export const maxAcademyPauseMs = 30_000;

/** The size limit of one answer of the academy, in bytes. */
export const academyMaxBytes = 5 * 1024 * 1024;

// The only paths the client sends to: robots.txt, the overview of the help
// pages, the index of the REST interface of WordPress, the help pages and
// their two taxonomies, and the help pages of another language.
const academyPaths: readonly RegExp[] = [
  /^\/robots\.txt$/,
  /^\/de\/help\/$/,
  /^\/de\/wp-json\/$/,
  /^\/de\/wp-json\/wp\/v2\/(?:docs|doc_category|knowledge_base)$/,
  /^\/[a-z]{2}\/wp-json\/wp\/v2\/docs$/,
];

const academyQueryNames: ReadonlySet<string> = new Set([
  'per_page',
  'page',
  '_fields',
]);

const academyQueryValue = /^[A-Za-z0-9_,.]{1,200}$/;

/** One request to the academy. */
export interface AcademyRequest {
  /** One of the fixed paths, starting with `/`. */
  readonly path: string;
  /** Query parameters in order: only `per_page`, `page` and `_fields`. */
  readonly query?: readonly (readonly [string, string])[];
}

/** What the probe sees of an answer of the academy. */
export interface AcademyResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The body as text. */
  readonly text: string;
  /** The parsed body if it is JSON, otherwise `undefined`. */
  readonly body: unknown;
}

/** A client bound to the academy, without any token. */
export interface AcademyClient {
  /**
   * Sends one GET request, after the pause if it is not the first.
   *
   * @param request - Path and query.
   * @returns The answer, already read.
   * @throws {SpikeError} Before any request if path or query are not fixed ones, and on network errors, redirects and oversized answers.
   */
  get(request: AcademyRequest): Promise<AcademyResponse>;
  /**
   * Raises the pause between two requests, for a `Crawl-delay`. It never
   * lowers it.
   *
   * @param milliseconds - The pause that `robots.txt` asks for.
   * @throws {SpikeError} If the pause is longer than {@link maxAcademyPauseMs}.
   */
  slowDown(milliseconds: number): void;
}

/** Settings of the client. There is deliberately no token among them. */
export interface AcademyOptions {
  readonly fetch?: FetchFunction;
  /** How the client waits between two requests. */
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function academyUrl(request: AcademyRequest): URL {
  const url = new URL(request.path, academyOrigin);
  if (
    !request.path.startsWith('/') ||
    url.origin !== academyOrigin ||
    url.pathname !== request.path ||
    url.search !== '' ||
    url.hash !== '' ||
    !isPlainPath(url.pathname) ||
    !academyPaths.some((path) => path.test(url.pathname))
  ) {
    throw new SpikeError('INTERN');
  }
  for (const [name, value] of request.query ?? []) {
    if (!academyQueryNames.has(name) || !academyQueryValue.test(value)) {
      throw new SpikeError('INTERN');
    }
    url.searchParams.append(name, value);
  }
  return url;
}

/**
 * Creates the client for the academy.
 *
 * @param options - Fetch, how to wait, and limits.
 * @returns A client that sends only the requests described above.
 * @example
 * ```ts
 * const academy = createAcademyClient({ wait });
 * const robots = await academy.get({ path: '/robots.txt' });
 * ```
 */
export function createAcademyClient(options: AcademyOptions): AcademyClient {
  let pause = academyPauseMs;
  let first = true;
  return {
    async get(request: AcademyRequest): Promise<AcademyResponse> {
      const url = academyUrl(request);
      if (!first) {
        await options.wait(pause);
      }
      first = false;
      const fetchFunction = options.fetch ?? fetch;
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await fetchFunction(url, {
          method: 'GET',
          headers: new Headers({
            Accept: 'application/json, text/plain;q=0.9, text/html;q=0.8',
            'User-Agent': userAgent,
          }),
          credentials: 'omit',
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
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
          options.maxBytes ?? academyMaxBytes,
        );
      } catch (error) {
        throw error instanceof SpikeError
          ? error
          : new SpikeError(classifyNetworkError(error));
      }
      const text = new TextDecoder().decode(bytes);
      let body: unknown = undefined;
      if ((response.headers.get('content-type') ?? '').includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { status: response.status, headers: response.headers, text, body };
    },
    slowDown(milliseconds: number): void {
      if (!(milliseconds <= maxAcademyPauseMs)) {
        throw new SpikeError('INTERN');
      }
      pause = Math.max(pause, milliseconds);
    },
  };
}
