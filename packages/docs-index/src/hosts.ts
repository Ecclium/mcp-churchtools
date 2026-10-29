/**
 * The check of hosts in the facts, the index and `SOURCES.json`
 * (ADR 0027, ADR 0066). Only two hosts may stand there: the placeholder
 * `example.church.tools` and the public host of the Academy. A host under
 * `church.tools` can point to a congregation, and every other host is a
 * link the attribution does not need (D6, D14).
 *
 * The check is a heuristic over words, not a parser of URLs. It finds a
 * URL with a scheme, a target that starts with `//`, an e-mail address,
 * every name under `church.tools`, a name that starts with `www.` and a
 * name with one of the endings in {@link checkedEndings}. It does not
 * check every ending, because paths of fields such as `group.name` would
 * count as hosts. What it finds, it reports as a kind, never as the host.
 *
 * @packageDocumentation
 */

/** The public host of the Academy, the one host besides the placeholder. */
export const academyHost = 'churchtools.academy';

/** The origin of every link to a help page. */
export const academyOrigin = `https://${academyHost}`;

/** The hosts the facts, the index and `SOURCES.json` may name. */
export const allowedHosts = Object.freeze([
  academyHost,
  'example.church.tools',
] as const);

/** The one domain an e-mail address may have: the placeholder. */
export const allowedMailDomain = 'example.org';

/** The endings that make a name without a scheme count as a host. */
export const checkedEndings = Object.freeze([
  'academy',
  'at',
  'ch',
  'church',
  'com',
  'de',
  'eu',
  'io',
  'li',
  'net',
  'org',
  'tools',
] as const);

/** The kinds of host the check tells apart. */
export type HostKind =
  'church-tools' | 'ip' | 'mail' | 'name' | 'protocol-relative' | 'url' | 'www';

/** Where a value holds hosts that are not allowed, and of which kinds. */
export interface HostFinding {
  /** The path of the string, such as `entries[2].text`. */
  readonly path: string;
  /** The kinds found, sorted. */
  readonly kinds: readonly HostKind[];
}

/**
 * Finds the hosts in a text that are not allowed.
 *
 * @param text - Any text.
 * @returns The kinds found, sorted and each once, or an empty list.
 * @example
 * ```ts
 * findForeignHosts('see https://churchtools.academy/de/help/'); // []
 * findForeignHosts('write to someone@example.com'); // ['mail', 'name']
 * ```
 */
export function findForeignHosts(text: string): readonly HostKind[] {
  const found = new Set<HostKind>();
  // NFKC turns full-width letters and dots into plain ones, as a browser
  // would before it resolves a name.
  const folded = text.normalize('NFKC').replace(otherDots, '.').toLowerCase();
  if (bracketedHost.test(folded)) {
    found.add('url');
  }
  for (const token of folded.split(separators)) {
    if (token !== '') {
      inspectToken(token, found);
    }
  }
  return [...found].sort();
}

/**
 * Finds the strings in a value that hold hosts that are not allowed: the
 * strings of a parsed JSON value, its keys included.
 *
 * @param value - A parsed JSON value.
 * @returns One finding per string with hosts, in the order of the value.
 * @example
 * ```ts
 * findHostsIn({ entries: [{ text: 'www.example.com' }] });
 * // [{ path: 'entries[0].text', kinds: ['name', 'www'] }]
 * ```
 */
export function findHostsIn(value: unknown): readonly HostFinding[] {
  const findings: HostFinding[] = [];
  walkStrings(value, (path, text) => {
    const kinds = findForeignHosts(text);
    if (kinds.length > 0) {
      findings.push({ path, kinds });
    }
  });
  return findings;
}

/**
 * Calls `visit` for every string in a parsed JSON value and for every key
 * of its objects. A key is visited at the path of its object, and the
 * path names a key only if it is a plain name, so no text from the value
 * reaches a path.
 *
 * @param value - A parsed JSON value.
 * @param visit - Called with the path and the text of each string.
 * @param path - The path of the value itself.
 * @example
 * ```ts
 * walkStrings({ a: ['x'] }, (path, text) => seen.push(`${path}=${text}`));
 * // seen: ['a[0]=x'] and the key 'a' at ''
 * ```
 */
export function walkStrings(
  value: unknown,
  visit: (path: string, text: string) => void,
  path = '',
): void {
  if (typeof value === 'string') {
    visit(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walkStrings(item, visit, `${path}[${String(index)}]`);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      visit(path, key);
      const name = plainKey.test(key) ? key : '*';
      walkStrings(item, visit, path === '' ? name : `${path}.${name}`);
    }
  }
}

const plainKey = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Markdown and JSON put hosts between brackets, quotes and parentheses,
// so these split words; a dot, a slash, a colon, a backslash and @ stay
// inside. Before the patterns run, a backslash counts as a slash, as
// browsers read it in a URL, and a Markdown escape \. as a dot.
const separators = /[\s<>()[\]{}"'`|,;*]+/u;

// Every quantifier is bounded or follows a fixed text, so that no
// pattern takes more than linear time on a long word.
// Dots that NFKC keeps but a browser reads as a dot in a name: the
// ideographic and the half-width ideographic full stop.
const otherDots = /[\u3002\uFF61]/g;
const urlPattern = /[a-z][a-z0-9+.-]{0,30}:\/\/([^/?#]{0,300})/g;
// Browsers also follow a web link with fewer slashes, such as https:host.
const webPattern = /(?:https?|ftps?|wss?):\/{0,3}([^/?#]{0,300})/g;
// A host in brackets, as an IPv6 address in a URL. Brackets split words,
// so this looks at the whole text.
const bracketedHost = /[a-z]:\/{0,3}\[/;
const ipv4Pattern =
  /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/;
const protocolRelativePattern =
  /^\/\/([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10})/;
const mailPattern =
  /[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10})/g;
const namePattern = /[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}/g;
const lettersOnly = /^[a-z]{2,63}$/;

const allowedNames: readonly string[] = Object.freeze([
  ...allowedHosts,
  allowedMailDomain,
]);

function inspectToken(raw: string, found: Set<HostKind>): void {
  const token = raw.replaceAll('\\.', '.').replaceAll('\\', '/');
  for (const pattern of [urlPattern, webPattern]) {
    for (const match of token.matchAll(pattern)) {
      const host = hostOf(match[1] ?? '');
      if (host !== '' && !isAllowedHost(host)) {
        found.add('url');
      }
    }
  }
  if (ipv4Pattern.test(token)) {
    found.add('ip');
  }
  const relative = protocolRelativePattern.exec(token);
  if (relative !== null && !isAllowedHost(relative[1] ?? '')) {
    found.add('protocol-relative');
  }
  for (const match of token.matchAll(mailPattern)) {
    if (match[1] !== allowedMailDomain) {
      found.add('mail');
    }
  }
  for (const match of token.matchAll(namePattern)) {
    const kind = kindOfName(match[0]);
    if (kind !== undefined) {
      found.add(kind);
    }
  }
}

// The host of the part after "://": without user, port and a final dot.
function hostOf(authority: string): string {
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = afterUser.indexOf(':');
  const host = colon === -1 ? afterUser : afterUser.slice(0, colon);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function isAllowedHost(host: string): boolean {
  return (allowedHosts as readonly string[]).includes(host);
}

function kindOfName(name: string): HostKind | undefined {
  if (allowedNames.includes(name)) {
    return undefined;
  }
  if (name === 'church.tools' || name.endsWith('.church.tools')) {
    return 'church-tools';
  }
  if (name.startsWith('www.')) {
    return 'www';
  }
  const ending = name.slice(name.lastIndexOf('.') + 1);
  if (
    lettersOnly.test(ending) &&
    (checkedEndings as readonly string[]).includes(ending)
  ) {
    return 'name';
  }
  return undefined;
}
