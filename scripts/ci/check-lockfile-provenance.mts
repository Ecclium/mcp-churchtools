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
 * through a trusted publisher. If one lacks either, comes from somewhere
 * other than the registry, or the registry cannot be asked, the check
 * fails.
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

/**
 * Reads the `lockfileVersion` of pnpm-lock.yaml.
 *
 * @param lockfile - Content of pnpm-lock.yaml.
 * @returns The version, such as `9.0`, or undefined.
 */
export function lockfileVersion(lockfile: string): string | undefined {
  return /^lockfileVersion: '?([^'\s]+)'?\s*$/m.exec(lockfile)?.[1];
}

/**
 * Lists the keys of the `packages:` section of pnpm-lock.yaml (version 9)
 * with their `resolution:` line. Each key names one resolved package, such
 * as `vitest@5.0.3` or `'@vitest/coverage-v8@5.0.3'`, without the peer
 * suffix that the `snapshots:` section adds. Line endings are normalised,
 * so a lockfile written with CRLF reads the same.
 *
 * @param lockfile - Content of pnpm-lock.yaml.
 * @returns The keys without quotes, each with its resolution, or an empty
 *   string if it has none.
 */
export function lockedPackages(lockfile: string): Map<string, string> {
  const packages = new Map<string, string>();
  let inPackages = false;
  let current: string | undefined;
  for (const line of lockfile.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === 'packages:';
      current = undefined;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const key = /^ {2}(\S.*):$/.exec(line)?.[1];
    if (key !== undefined) {
      current = key.replace(/^'(.*)'$/, '$1');
      packages.set(current, '');
    } else if (current !== undefined && /^ {4}resolution:/.test(line)) {
      packages.set(current, line.trim());
    }
  }
  return packages;
}

/** A package that a change adds to the lockfile, or whose source changes. */
export interface AddedPackage {
  /** The key, such as `vitest@5.0.3`. */
  readonly key: string;
  /** Its `resolution:` line in the new lockfile. */
  readonly resolution: string;
}

/**
 * Lists the packages that are new in the second lockfile or whose
 * resolution differs from the first, so that a changed source of a known
 * version is checked as well.
 *
 * @param base - pnpm-lock.yaml before the change.
 * @param head - pnpm-lock.yaml after the change.
 * @returns The packages, sorted by key.
 */
export function addedPackages(base: string, head: string): AddedPackage[] {
  const before = lockedPackages(base);
  return [...lockedPackages(head)]
    .filter(([key, resolution]) => before.get(key) !== resolution)
    .map(([key, resolution]) => ({ key, resolution }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Splits a key such as `@scope/name@1.2.3` into name and version. Only a
 * key with an exact version can come from the registry.
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
  return at > 0 && semver.test(version) && !name.includes(':')
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
  for (const { key: entry, resolution } of entries) {
    const parsed = splitEntry(entry);
    // A registry package resolves to an integrity hash alone; a tarball or
    // Git resolution comes from somewhere else.
    if (
      parsed === undefined ||
      !/^resolution: \{integrity: [^,}]+\}$/.test(resolution)
    ) {
      lines.push(`${entry}: nicht aus der Registry`);
      failed += 1;
      continue;
    }
    const url = `https://registry.npmjs.org/${parsed.name.replace('/', '%2f')}/${parsed.version}`;
    let evidence: Evidence;
    try {
      evidence = evidenceOf(await fetchJson(url));
    } catch {
      lines.push(`${entry}: Registry nicht erreichbar`);
      failed += 1;
      continue;
    }
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
  }
  if (lockedPackages(after).size === 0 && /^\s+specifier:/m.test(after)) {
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
