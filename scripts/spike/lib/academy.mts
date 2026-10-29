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

// The only fields a probe or `pnpm docs:refresh` may ask for. The authors
// of a page are people, so no field about them is among these, whatever
// a caller asks for. The refresh needs the title and the link of a page
// for the facts and their attribution (ADR 0027).
const academyFields: ReadonlySet<string> = new Set([
  'id',
  'slug',
  'parent',
  'status',
  'modified_gmt',
  'content',
  'doc_category',
  'knowledge_base',
  'link',
  'title',
]);

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
  /**
   * The User-Agent, also the product token `robots.txt` is read for.
   * The probes send theirs, `pnpm docs:refresh` its own.
   */
  readonly userAgent?: string;
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
    if (
      !academyQueryNames.has(name) ||
      !academyQueryValue.test(value) ||
      (name === '_fields' &&
        !value.split(',').every((field) => academyFields.has(field)))
    ) {
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
            'User-Agent': options.userAgent ?? userAgent,
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

/** What `robots.txt` says for the paths a probe reads. */
export interface RobotsRules {
  /** Whether a group names the agent of the probes itself. */
  readonly ownGroup: boolean;
  /** Whether a group for every agent (`*`) exists. */
  readonly starGroup: boolean;
  /** The rules of the groups that apply, in order. */
  readonly rules: readonly { readonly allow: boolean; readonly path: string }[];
  /** The `Crawl-delay` of the groups that apply, in seconds, if any. */
  readonly crawlDelay: number | undefined;
  /** Whether the file names a sitemap. */
  readonly sitemap: boolean;
}

/**
 * Reads `robots.txt` as RFC 9309 describes it. The groups that name the
 * agent apply, and only without such a group those for every agent.
 *
 * @param text - The content of `robots.txt`.
 * @param agent - The product token of the probes, such as the User-Agent.
 * @returns The rules that apply to the agent.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  interface Group {
    agents: string[];
    rules: { allow: boolean; path: string }[];
    crawlDelay: number | undefined;
  }
  const groups: Group[] = [];
  let current: Group | undefined;
  let sitemap = false;
  let inAgents = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (current === undefined || !inAgents) {
        current = { agents: [], rules: [], crawlDelay: undefined };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgents = true;
    } else if (key === 'sitemap') {
      sitemap = sitemap || value !== '';
    } else if (
      current !== undefined &&
      (key === 'allow' || key === 'disallow' || key === 'crawl-delay')
    ) {
      // Only a rule ends the list of agents of a group. Other records,
      // such as `Host`, are ignored, as RFC 9309 asks.
      inAgents = false;
      if ((key === 'allow' || key === 'disallow') && value !== '') {
        current.rules.push({
          allow: key === 'allow',
          path: normalizeRobotsPath(value),
        });
      } else if (
        key === 'crawl-delay' &&
        /^\d{1,6}(?:\.\d{1,3})?$/.test(value)
      ) {
        current.crawlDelay = Number(value);
      }
    }
  }
  const token = agent.toLowerCase();
  const own = groups.filter((group) => group.agents.includes(token));
  const star = groups.filter((group) => group.agents.includes('*'));
  const applying = own.length > 0 ? own : star;
  const delays = applying
    .map((group) => group.crawlDelay)
    .filter((delay): delay is number => delay !== undefined);
  return {
    ownGroup: own.length > 0,
    starGroup: star.length > 0,
    rules: applying.flatMap((group) => group.rules),
    crawlDelay:
      delays.length === 0
        ? undefined
        : delays.reduce((longest, delay) => Math.max(longest, delay)),
    sitemap,
  };
}

/**
 * Brings a path or a rule of robots.txt into one form, so that encoded and
 * plain octets compare equal, as RFC 9309 asks: an encoded unreserved
 * character is decoded, every other code is written in upper case.
 *
 * @param path - Path with query, or the path of a rule.
 * @returns The path in its normal form.
 */
export function normalizeRobotsPath(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (code: string, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9\-._~]$/.test(character)
      ? character
      : `%${hex.toUpperCase()}`;
  });
}

// Matches a path against a rule of robots.txt: `*` stands for any run of
// characters, a `$` at the end for the end of the path. A plain loop with
// one point to go back to stays linear in practice and needs no regular
// expression built from the file.
function matchesRule(path: string, rule: string): boolean {
  const anchored = rule.endsWith('$');
  const pattern = anchored ? rule.slice(0, -1) : rule;
  let p = 0;
  let r = 0;
  let star = -1;
  let resume = 0;
  while (p < path.length) {
    if (r < pattern.length && pattern[r] === '*') {
      star = r;
      resume = p;
      r += 1;
    } else if (r < pattern.length && pattern[r] === path[p]) {
      p += 1;
      r += 1;
    } else if (r === pattern.length && !anchored) {
      return true;
    } else if (star !== -1) {
      r = star + 1;
      resume += 1;
      p = resume;
    } else {
      return false;
    }
  }
  while (r < pattern.length && pattern[r] === '*') {
    r += 1;
  }
  return r === pattern.length;
}

/**
 * Tells whether the rules allow a path: the longest matching rule wins,
 * and of two equally long ones the one that allows.
 *
 * @param rules - The rules from {@link parseRobots}.
 * @param path - A path the probe wants to read, with its query, since rules
 *   such as `Disallow: /*?page=` look at the query too.
 * @returns Whether the path may be read.
 */
export function robotsAllow(rules: RobotsRules, path: string): boolean {
  const normal = normalizeRobotsPath(path);
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of rules.rules) {
    if (!matchesRule(normal, rule.path)) {
      continue;
    }
    if (
      best === undefined ||
      rule.path.length > best.length ||
      (rule.path.length === best.length && rule.allow)
    ) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best?.allow ?? true;
}

const hreflangPattern =
  /<link\b[^>]{0,500}?\bhreflang\s*=\s*["']([A-Za-z-]{2,10})["']/gi;
const languageForm = /^(?:[a-z]{2}(?:-[a-z]{2})?|x-default)$/;

/**
 * Lists the languages a page links to with `hreflang`.
 *
 * @param html - The HTML of the page.
 * @returns The codes in lower case, each once, in order.
 */
export function hreflangCodes(html: string): string[] {
  const codes = new Set<string>();
  for (const match of html.matchAll(hreflangPattern)) {
    const code = (match[1] ?? '').toLowerCase();
    if (languageForm.test(code)) {
      codes.add(code);
    }
  }
  return [...codes];
}

/** What a help page holds, without any of its text. */
export interface PageFeatures {
  readonly images: boolean;
  readonly videos: boolean;
  readonly tables: boolean;
  readonly code: boolean;
  /** The targets of its links, as written. */
  readonly links: readonly string[];
  /** The text without tags, for its size and for hosts in the text. */
  readonly text: string;
}

const hrefPattern = /\bhref\s*=\s*["']([^"']{0,2048})["']/gi;

/**
 * Finds what a help page holds: images, videos and embedded frames,
 * tables, code, the targets of its links, and its text without tags.
 *
 * @param html - The rendered content of the page.
 * @returns The features of the page.
 */
export function pageFeatures(html: string): PageFeatures {
  return {
    images: /<img\b/i.test(html),
    videos: /<(?:video|iframe|embed|object)\b/i.test(html),
    tables: /<table\b/i.test(html),
    code: /<(?:pre|code)\b/i.test(html),
    links: [...html.matchAll(hrefPattern)].map((match) => match[1] ?? ''),
    // A tag ends at the next `<` as well, so text full of `<` without `>`
    // costs linear time, not quadratic.
    text: html
      .replace(/<[^<>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

const bytesPerMebibyte = 1024 * 1024;

/**
 * Gives a number of bytes as text, so that no exact number reaches the
 * output.
 *
 * @param bytes - A number of bytes.
 * @returns MiB with one decimal, below 1 MiB whole KiB rounded up.
 */
export function formatSize(bytes: number): string {
  return bytes < bytesPerMebibyte
    ? `${String(Math.ceil(bytes / 1024))} KiB`
    : `${(bytes / bytesPerMebibyte).toFixed(1)} MiB`;
}
