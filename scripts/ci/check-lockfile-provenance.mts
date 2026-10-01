/**
 * Checks the evidence of origin of every package version that a change adds
 * to pnpm-lock.yaml.
 *
 * Renovate merges patch and minor updates of a few development tools on its
 * own (ADR 0021). Such an update also brings new versions of the tools'
 * dependencies, and many of those are published without any evidence of
 * their origin. The trust policy of pnpm compares a version only with
 * earlier versions of the same package, so it does not protect a package
 * that never had such evidence. This check asks the npm registry, for each
 * added version, whether it has a provenance attestation and was published
 * through a trusted publisher, and whether the integrity in the lockfile is
 * the one the registry lists for that version. If one lacks either piece of
 * evidence, has another integrity, comes from somewhere other than the
 * registry, or the registry cannot be asked, the check fails.
 *
 * It is not a required check. A person can still merge after looking at the
 * named packages, while Renovate, which merges only when every check has
 * passed, leaves the pull request open.
 *
 * The registry also returns names and e-mail addresses of maintainers. The
 * output names only packages and whether each piece of evidence is there,
 * because the log of a public repository is public.
 *
 * Usage: `node scripts/ci/check-lockfile-provenance.mts <base>` compares
 * pnpm-lock.yaml at the commit `<base>` with the file in the working tree.
 *
 * @packageDocumentation
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The evidence of origin of one package version. */
export interface Evidence {
  /** The version has a provenance attestation. */
  readonly provenance: boolean;
  /** The version was published through a trusted publisher. */
  readonly trustedPublisher: boolean;
}

/** Returns the parsed JSON at a URL, or throws. */
export type Fetcher = (url: string) => Promise<unknown>;

/** The result of checking the added versions. */
export interface ProvenanceReport {
  /** One line per added version, in German. */
  readonly lines: readonly string[];
  /** Number of versions that do not pass. */
  readonly failed: number;
}

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The name becomes part of the registry URL, where a character such as `?`
// or `#` or a name such as `..` would ask about a different package than
// the one in the lockfile. Only ASCII letters, digits and `._~-` pass, as
// `@scope/name` or as a name that starts with a letter or digit, and no
// part starts with a dot. The rare older names with one of `'!()*` fail,
// and a person looks at them.
const packageName = /^(?:@[\w~-][\w.~-]*\/[\w~-][\w.~-]*|[A-Za-z0-9][\w.~-]*)$/;

/**
 * Reads the `lockfileVersion` of pnpm-lock.yaml.
 *
 * @param lockfile - Content of pnpm-lock.yaml.
 * @returns The version, such as `9.0`, or undefined.
 */
export function lockfileVersion(lockfile: string): string | undefined {
  return /^lockfileVersion: '?([^'\s]+)'?\s*$/m.exec(lockfile)?.[1];
}

/** The lockfile uses a form that this check cannot read safely. */
export class UnreadableLockfile extends Error {}

/** One entry of the `packages:` section of pnpm-lock.yaml. */
export interface LockedPackage {
  /** Its `resolution:` line, or an empty string if it has none. */
  readonly resolution: string;
  /** The names of its fields, such as `resolution` or `engines`. */
  readonly fields: readonly string[];
}

// pnpm writes the lockfile as YAML in a narrow form: two spaces per level,
// no comments, anchors, aliases, tags or explicit keys, and every quoted
// string and every flow collection on one line. Only long texts span lines,
// as block scalars such as `|-`, which end where the indentation does. This
// reader accepts only that form. pnpm reads any YAML: a string or bracket
// left open makes the following lines, even one at the start of a line,
// part of a value for pnpm, while a reader of lines could take them for a
// new section and skip the packages after it. With anchors, aliases, merge
// keys or a key in another form, pnpm could see a package or a field that
// this reader does not. Any other form therefore stops the check.
const topLevelLine = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/;
const keyLine = /^ {2}('(?:[^']|'')+'|[^\s'"?:,[\]{}#&*!|<>%@`-]\S*):( \{\})?$/;
const fieldLine = /^ {4}([A-Za-z][A-Za-z0-9]*):(?: |$)/;
const quotedAt = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/y;

/**
 * Measures the quoted string that starts at `start`.
 *
 * @param text - One line of the lockfile.
 * @param start - Index of the opening quote.
 * @returns Its length with both quotes, or undefined if it does not end
 *   on this line.
 */
function quotedLength(text: string, start: number): number | undefined {
  quotedAt.lastIndex = start;
  return quotedAt.exec(text)?.[0].length;
}

/**
 * Checks that the flow collection at the start of `text` closes on its
 * line, with nothing after it. A quote starts a string only where a value
 * can start; inside a word it is a character like any other.
 *
 * @param text - A value that starts with `[` or `{`.
 * @returns Whether it closes, without anchors, aliases, tags or comments.
 */
function flowCloses(text: string): boolean {
  let depth = 0;
  let previous = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const valueStart = previous === '' || '[{,:?'.includes(previous);
    if (valueStart && (char === "'" || char === '"')) {
      const length = quotedLength(text, index);
      if (length === undefined) {
        return false;
      }
      index += length - 1;
      previous = char;
      continue;
    }
    if (
      (valueStart && '&*!?'.includes(char)) ||
      (char === '#' && text.charAt(index - 1) === ' ')
    ) {
      return false;
    }
    if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        return /^ *$/.test(text.slice(index + 1));
      }
    }
    if (char !== ' ') {
      previous = char;
    }
  }
  return false;
}

/**
 * Tells how a value after `key: ` or `- ` ends.
 *
 * @param value - The value, without the spaces before it.
 * @returns `line` if it ends on its line, `block` for the start of a block
 *   scalar, or undefined for a form that pnpm does not write.
 */
function valueForm(value: string): 'line' | 'block' | undefined {
  if (value === '') {
    return 'line';
  }
  const first = value.charAt(0);
  if (first === "'" || first === '"') {
    const length = quotedLength(value, 0);
    return length !== undefined && /^ *$/.test(value.slice(length))
      ? 'line'
      : undefined;
  }
  if (first === '[' || first === '{') {
    return flowCloses(value) ? 'line' : undefined;
  }
  if (first === '|' || first === '>') {
    return /^[|>][-+]?$/.test(value) ? 'block' : undefined;
  }
  // Anchors, aliases, tags, explicit keys, reserved characters, comments.
  return '&*!?%@`#'.includes(first) || / #/.test(value) ? undefined : 'line';
}

/**
 * Tells how a line of the lockfile ends.
 *
 * @param content - The line without its indentation.
 * @returns `line` if everything it opens closes on it, `block` for the
 *   start of a block scalar, or undefined for a form that pnpm does not
 *   write.
 */
function lineForm(content: string): 'line' | 'block' | undefined {
  // Items of block sequences.
  const rest = content.slice(/^(?:- +)*/.exec(content)?.[0].length ?? 0);
  if (rest.startsWith("'") || rest.startsWith('"')) {
    const length = quotedLength(rest, 0);
    if (length === undefined) {
      return undefined;
    }
    const after = rest.slice(length);
    if (/^ *$/.test(after)) {
      return 'line';
    }
    return /^:(?: |$)/.test(after)
      ? valueForm(after.slice(1).replace(/^ +/, ''))
      : undefined;
  }
  // A plain key ends at the first colon before a space or the line end.
  const colon = rest.search(/:(?: |$)/);
  if (colon === -1) {
    return valueForm(rest);
  }
  const key = rest.slice(0, colon);
  return key === '' || '[{&*!?|>%@`#'.includes(key.charAt(0)) || / #/.test(key)
    ? undefined
    : valueForm(rest.slice(colon + 1).replace(/^ +/, ''));
}

/**
 * Reads the `packages:` section of pnpm-lock.yaml (version 9). Each key
 * names one resolved package, such as `vitest@5.0.3` or
 * `'@vitest/coverage-v8@5.0.3'`, without the peer suffix that the
 * `snapshots:` section adds. Every key of `snapshots:` must have its
 * package here. Line endings are normalised, so a lockfile written with
 * CRLF reads the same.
 *
 * @param lockfile - Content of pnpm-lock.yaml.
 * @returns The keys without quotes, each with its resolution and fields.
 * @throws {UnreadableLockfile} For a form that pnpm does not write.
 */
export function lockedPackages(lockfile: string): Map<string, LockedPackage> {
  const packages = new Map<string, { resolution: string; fields: string[] }>();
  const snapshots: string[] = [];
  const sections = new Set<string>();
  let section: string | undefined;
  let entry: { resolution: string; fields: string[] } | undefined;
  // What the last line of the section was, so that a field follows a key
  // and a deeper line follows a field.
  let previous: 'key' | 'field' | undefined;
  // The indentation of the line that opened a block scalar.
  let block: number | undefined;
  const lines = lockfile.replace(/\r\n?/g, '\n').split('\n');
  for (const [index, line] of lines.entries()) {
    const at = `Zeile ${String(index + 1)}`;
    // YAML 1.1 reads these characters as line breaks, this reader does not.
    if (/[\u0085\u2028\u2029]/.test(line)) {
      throw new UnreadableLockfile(`${at}: Zeichen für einen Zeilenumbruch`);
    }
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const content = line.slice(indent);
    if (/^[ \t]*$/.test(content) || (block !== undefined && indent > block)) {
      continue;
    }
    block = undefined;
    const form = lineForm(content);
    if (form === undefined) {
      throw new UnreadableLockfile(
        `${at}: Wert, der nicht auf seiner Zeile endet, oder unbekannte Form`,
      );
    }
    if (form === 'block') {
      block = indent;
    }
    if (indent === 0) {
      const top = topLevelLine.exec(line);
      if (top === null) {
        throw new UnreadableLockfile(
          `${at}: unbekannte Form auf oberster Ebene`,
        );
      }
      section = top[1];
      entry = undefined;
      previous = undefined;
      if (section === 'packages' || section === 'snapshots') {
        if (
          sections.has(section) ||
          (top[2] !== undefined && top[2] !== '{}')
        ) {
          throw new UnreadableLockfile(
            `${at}: unbekannte Form des Abschnitts ${section}`,
          );
        }
        sections.add(section);
      }
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') {
      continue;
    }
    if (indent === 2) {
      const key = keyLine.exec(line);
      if (key?.[1] === undefined) {
        throw new UnreadableLockfile(`${at}: unbekannte Form eines Schlüssels`);
      }
      const name = key[1].startsWith("'")
        ? key[1].slice(1, -1).replaceAll("''", "'")
        : key[1];
      if (section === 'packages') {
        entry = { resolution: '', fields: [] };
        packages.set(name, entry);
      } else {
        snapshots.push(name);
      }
      // An entry written as `{}` has no fields below it.
      previous = key[2] === undefined ? 'key' : undefined;
      continue;
    }
    if (indent === 4 && previous !== undefined) {
      const field = fieldLine.exec(line)?.[1];
      // pnpm's YAML reader refuses a repeated key, so a repeat here means
      // that this reader took part of a value for a field.
      if (field === undefined || entry?.fields.includes(field) === true) {
        throw new UnreadableLockfile(`${at}: unbekannte Form eines Felds`);
      }
      entry?.fields.push(field);
      if (entry !== undefined && field === 'resolution') {
        entry.resolution = line.trim();
      }
      previous = 'field';
      continue;
    }
    if (indent < 6 || previous !== 'field') {
      throw new UnreadableLockfile(`${at}: unerwartete Einrückung`);
    }
  }
  for (const key of snapshots) {
    if (!packages.has(key.replace(/\(.*$/, ''))) {
      throw new UnreadableLockfile(
        `${key} steht unter snapshots:, aber nicht unter packages:`,
      );
    }
  }
  return packages;
}

/** A package that a change adds to the lockfile, or whose source changes. */
export interface AddedPackage extends LockedPackage {
  /** The key, such as `vitest@5.0.3`. */
  readonly key: string;
}

/**
 * Lists the packages that are new in the second lockfile or whose
 * resolution differs from the first, so that a changed source of a known
 * version is checked as well.
 *
 * @param base - pnpm-lock.yaml before the change.
 * @param head - pnpm-lock.yaml after the change.
 * @returns The packages, sorted by key.
 * @throws {UnreadableLockfile} For a form that pnpm does not write.
 */
export function addedPackages(base: string, head: string): AddedPackage[] {
  const before = lockedPackages(base);
  return [...lockedPackages(head)]
    .filter(
      ([key, { resolution }]) => before.get(key)?.resolution !== resolution,
    )
    .map(([key, locked]) => ({ key, ...locked }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Splits a key such as `@scope/name@1.2.3` into name and version. Only a
 * key with an exact version and a name that can go into the registry URL
 * unchanged is checked against the registry.
 *
 * @param entry - A key of the `packages:` section.
 * @returns Name and version, or undefined if the key names no registry
 *   version.
 */
export function splitEntry(
  entry: string,
): { name: string; version: string } | undefined {
  const at = entry.lastIndexOf('@');
  const name = entry.slice(0, at);
  const version = entry.slice(at + 1);
  return at > 0 && semver.test(version) && packageName.test(name)
    ? { name, version }
    : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Reads the evidence of origin from the registry document of one version.
 * Only these two fields are read; everything else in the document, such as
 * the names and addresses of maintainers, is ignored.
 *
 * @param manifest - The JSON from https://registry.npmjs.org/name/version.
 * @returns Whether attestation and trusted publisher are there.
 */
export function evidenceOf(manifest: unknown): Evidence {
  const dist = isObject(manifest) ? manifest['dist'] : undefined;
  const attestations = isObject(dist) ? dist['attestations'] : undefined;
  const user = isObject(manifest) ? manifest['_npmUser'] : undefined;
  return {
    provenance: isObject(attestations) && isObject(attestations['provenance']),
    trustedPublisher: isObject(user) && isObject(user['trustedPublisher']),
  };
}

/**
 * Reads the integrity the registry lists for one version.
 *
 * @param manifest - The JSON from https://registry.npmjs.org/name/version.
 * @returns `dist.integrity`, or undefined if it is missing.
 */
export function registryIntegrity(manifest: unknown): string | undefined {
  const dist = isObject(manifest) ? manifest['dist'] : undefined;
  const integrity = isObject(dist) ? dist['integrity'] : undefined;
  return typeof integrity === 'string' ? integrity : undefined;
}

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

/**
 * Asks the registry for the evidence of each added version.
 *
 * @param entries - Added or changed packages of the lockfile.
 * @param fetchJson - Fetches a registry document; injected for the tests.
 * @returns One line per version and the number of versions that fail.
 */
export async function checkPackages(
  entries: readonly AddedPackage[],
  fetchJson: Fetcher,
): Promise<ProvenanceReport> {
  const lines: string[] = [];
  let failed = 0;
  for (const { key: entry, resolution, fields } of entries) {
    const parsed = splitEntry(entry);
    // A registry package resolves to an integrity hash alone; a tarball or
    // Git resolution comes from somewhere else. pnpm writes a name or a
    // version into an entry only for such packages, and it installs the
    // version of that field rather than the one in the key.
    const integrity = /^resolution: \{integrity: ([^,}]+)\}$/.exec(
      resolution,
    )?.[1];
    if (
      parsed === undefined ||
      integrity === undefined ||
      fields.includes('name') ||
      fields.includes('version')
    ) {
      lines.push(`${entry}: nicht aus der Registry`);
      failed += 1;
      continue;
    }
    const url = `https://registry.npmjs.org/${parsed.name.replaceAll('/', '%2f')}/${parsed.version}`;
    let manifest: unknown;
    try {
      manifest = await fetchJson(url);
    } catch {
      lines.push(`${entry}: Registry nicht erreichbar`);
      failed += 1;
      continue;
    }
    // pnpm installs whatever matches the integrity in the lockfile. Only
    // when it is the one the registry lists for this version does the
    // evidence below belong to the package pnpm installs: another version
    // named in the entry, or a tarball from another registry set in an
    // .npmrc, has another integrity. A version without `dist.integrity`
    // is older than provenance and fails here.
    if (registryIntegrity(manifest) !== integrity) {
      lines.push(`${entry}: Prüfsumme weicht von der Registry ab`);
      failed += 1;
      continue;
    }
    const evidence = evidenceOf(manifest);
    lines.push(
      `${entry}: Herkunftsnachweis ${yesNo(evidence.provenance)}, vertrauenswürdiger Herausgeber ${yesNo(evidence.trustedPublisher)}`,
    );
    if (!evidence.provenance || !evidence.trustedPublisher) {
      failed += 1;
    }
  }
  return { lines, failed };
}

const fetchJson: Fetcher = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return response.json();
};

async function main(): Promise<number> {
  const [base, ...rest] = process.argv.slice(2);
  if (base === undefined || rest.length > 0) {
    console.error(
      'Aufruf: node scripts/ci/check-lockfile-provenance.mts <Basis>',
    );
    return 2;
  }
  const before = spawnSync('git', ['show', `${base}:pnpm-lock.yaml`], {
    encoding: 'utf8',
  });
  if (before.status !== 0) {
    console.error(
      `Das Lockfile im Commit ${base} lässt sich nicht lesen: ${before.stderr.trim()}`,
    );
    return 2;
  }
  const after = readFileSync('pnpm-lock.yaml', 'utf8');
  // An unknown format could hide packages from this reader and let the
  // check pass with nothing checked.
  for (const [name, text] of [
    ['Basis', before.stdout],
    ['Arbeitsbaum', after],
  ] as const) {
    if (lockfileVersion(text) !== '9.0') {
      console.error(
        `Das Lockfile (${name}) hat das Format ${String(lockfileVersion(text))}, diese Prüfung liest nur 9.0.`,
      );
      return 2;
    }
    try {
      lockedPackages(text);
    } catch (error) {
      if (!(error instanceof UnreadableLockfile)) {
        throw error;
      }
      console.error(
        `Das Lockfile (${name}) lässt sich nicht sicher lesen. ${error.message}`,
      );
      return 2;
    }
  }
  // Spaces only: `\s` would also match line breaks and take quadratic time
  // on a lockfile of blank lines.
  if (lockedPackages(after).size === 0 && /^ +specifier:/m.test(after)) {
    console.error('Im Lockfile stehen Abhängigkeiten, aber keine Pakete.');
    return 2;
  }
  const added = addedPackages(before.stdout, after);
  const report = await checkPackages(added, fetchJson);
  for (const line of report.lines) {
    console.log(line);
  }
  console.log(
    `Lockfile geprüft: ${String(added.length)} neue oder geänderte Paketversionen, davon ${String(report.failed)} nicht bestanden.`,
  );
  if (report.failed > 0) {
    console.error(
      'Renovate übernimmt diese Änderung nicht automatisch. Ist die Registry nicht erreichbar, starten Sie den Job später erneut. Sonst sehen Sie sich die genannten Pakete an, bevor Sie den Pull Request von Hand mergen.',
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
