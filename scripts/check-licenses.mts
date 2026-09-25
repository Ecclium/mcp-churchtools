/**
 * Checks the licences of all installed dependencies against two lists
 * (ADR 0021).
 *
 * Dependencies that ship with Ecclium may only use permissive licences.
 * Tools used during development may also use a few more, because they are
 * never distributed. An unknown licence is an error.
 *
 * Usage: `node scripts/check-licenses.mts`
 *
 * @packageDocumentation
 */
import { runPnpm } from './lib/pnpm.mts';

/** Licences allowed for dependencies that ship with Ecclium. */
export const runtimeLicences: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
]);

/** Licences allowed for tools that are only used during development. */
export const developmentLicences: ReadonlySet<string> = new Set([
  ...runtimeLicences,
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'MPL-2.0',
]);

/** One dependency as listed by `pnpm licenses list --json`. */
export interface LicenceEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

/** The output of `pnpm licenses list --json`, grouped by licence. */
export type LicenceReport = Readonly<Record<string, readonly LicenceEntry[]>>;

/**
 * Tells whether an SPDX licence expression is allowed by a list.
 *
 * `OR` needs one allowed side and `AND` needs both. A licence with a `WITH`
 * exception counts only if the whole term is on the list. Anything the
 * parser does not understand is not allowed.
 *
 * @param expression - Licence from a package manifest, such as `(MIT OR Apache-2.0)`.
 * @param allowed - Allowed licence identifiers.
 * @returns Whether the expression is allowed.
 */
export function isAllowed(
  expression: string,
  allowed: ReadonlySet<string>,
): boolean {
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let position = 0;
  const next = (): string | undefined => tokens[position];

  // or := and ('OR' and)* ; and := term ('AND' term)* ;
  // term := '(' or ')' | id ('WITH' id)?
  // Every branch consumes its tokens, so a syntax error is always noticed.
  const parseTerm = (): boolean | undefined => {
    const token = tokens[position++];
    if (token === '(') {
      const inner = parseOr();
      return tokens[position++] === ')' ? inner : undefined;
    }
    if (token === undefined || token === ')' || /^(AND|OR|WITH)$/.test(token)) {
      return undefined;
    }
    if (next() === 'WITH') {
      const exception = tokens[position + 1];
      position += 2;
      return exception === undefined
        ? undefined
        : allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  };
  const parseAnd = (): boolean | undefined => {
    let result = parseTerm();
    while (next() === 'AND') {
      position++;
      const right = parseTerm();
      result =
        result === undefined || right === undefined
          ? undefined
          : result && right;
    }
    return result;
  };
  const parseOr = (): boolean | undefined => {
    let result = parseAnd();
    while (next() === 'OR') {
      position++;
      const right = parseAnd();
      result =
        result === undefined || right === undefined
          ? undefined
          : result || right;
    }
    return result;
  };

  const result = parseOr();
  return result === true && position === tokens.length;
}

/**
 * Lists every dependency whose licence is not allowed.
 *
 * @param report - Output of `pnpm licenses list --json`.
 * @param allowed - Allowed licence identifiers.
 * @returns One `name@version (licence)` entry per violation, sorted.
 */
export function findViolations(
  report: LicenceReport,
  allowed: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const entries of Object.values(report)) {
    for (const entry of entries) {
      if (!isAllowed(entry.license, allowed)) {
        for (const version of entry.versions) {
          violations.push(`${entry.name}@${version} (${entry.license})`);
        }
      }
    }
  }
  return violations.sort();
}

/**
 * Counts the package versions in a report.
 *
 * @param report - Output of `pnpm licenses list --json`.
 * @returns The number of package versions.
 */
export function countPackages(report: LicenceReport): number {
  return Object.values(report)
    .flat()
    .reduce((sum, entry) => sum + entry.versions.length, 0);
}

function readReport(scope: '--dev' | '--prod'): LicenceReport {
  const output = runPnpm(['licenses', 'list', '--json', scope]);
  // Without dependencies in the scope, pnpm prints a sentence, not JSON.
  return output.trimStart().startsWith('{')
    ? (JSON.parse(output) as LicenceReport)
    : {};
}

function main(): number {
  const scopes = [
    ['zur Laufzeit', readReport('--prod'), runtimeLicences],
    ['für die Entwicklung', readReport('--dev'), developmentLicences],
  ] as const;
  let failures = 0;
  for (const [label, report, allowed] of scopes) {
    const violations = findViolations(report, allowed);
    failures += violations.length;
    for (const violation of violations) {
      console.error(`Nicht erlaubte Lizenz ${label}: ${violation}`);
    }
    console.log(
      `Lizenzen ${label}: ${String(countPackages(report))} Pakete geprüft, ${String(violations.length)} nicht erlaubt.`,
    );
  }
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
