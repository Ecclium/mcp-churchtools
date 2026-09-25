/**
 * Checks that the supply-chain settings of pnpm are in effect (ADR 0021).
 *
 * pnpm only warns about a setting it does not know and then ignores it. A
 * misspelt name in pnpm-workspace.yaml would therefore remove a protection
 * without anyone noticing. This script compares the effective values with
 * the expected ones and rejects every key in pnpm-workspace.yaml that it
 * does not know. An environment variable that overrides a value is caught
 * as well, because the effective values come from pnpm itself.
 *
 * Usage: `node scripts/check-pnpm-settings.mts`
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { runPnpm } from './lib/pnpm.mts';

/** The settings that must be in effect, with their values. */
export const expectedSettings: Readonly<Record<string, unknown>> = {
  minimumReleaseAge: 4320,
  minimumReleaseAgeExclude: [],
  minimumReleaseAgeStrict: true,
  minimumReleaseAgeIgnoreMissingTime: false,
  trustPolicy: 'no-downgrade',
  blockExoticSubdeps: true,
  strictDepBuilds: true,
  allowBuilds: {},
  verifyDepsBeforeRun: 'install',
  ignoreWorkspaceCycles: true,
};

/** The keys pnpm-workspace.yaml may contain. */
export const knownWorkspaceKeys: ReadonlySet<string> = new Set([
  'packages',
  ...Object.keys(expectedSettings),
]);

// An exception from the minimum release age names one exact version, so it
// cannot silently cover later releases of the same package.
const exactVersion =
  /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/**
 * Compares the effective pnpm settings with the expected ones.
 *
 * Two settings may deviate within limits: `minimumReleaseAgeExclude` may
 * name exact versions (`name@1.2.3`), and `allowBuilds` may list packages
 * whose scripts stay disabled (`false`). Every other value must match.
 *
 * @param actual - Effective settings, as printed by `pnpm config list --json`.
 * @returns One message per problem, empty if everything is in effect.
 */
export function compareSettings(
  actual: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const [key, expected] of Object.entries(expectedSettings)) {
    if (!(key in actual)) {
      problems.push(
        `Einstellung fehlt: ${key} (erwartet ${JSON.stringify(expected)})`,
      );
      continue;
    }
    const value = actual[key];
    if (key === 'minimumReleaseAgeExclude' && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string' || !exactVersion.test(entry)) {
          problems.push(
            `minimumReleaseAgeExclude erlaubt nur genaue Versionen wie name@1.2.3, nicht ${JSON.stringify(entry)}`,
          );
        }
      }
    } else if (
      key === 'allowBuilds' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      for (const [name, allowed] of Object.entries(value)) {
        if (allowed !== false) {
          problems.push(
            `allowBuilds darf keine Install-Skripte erlauben, auch nicht für ${name}`,
          );
        }
      }
    } else if (!isDeepStrictEqual(value, expected)) {
      problems.push(
        `Einstellung ${key} ist ${JSON.stringify(value)}, erwartet ${JSON.stringify(expected)}`,
      );
    }
  }
  return problems;
}

/**
 * Lists the top-level keys of pnpm-workspace.yaml that are not known.
 *
 * Reads keys that start at the beginning of a line, which is how the file is
 * written. Comments and nested entries are skipped.
 *
 * @param yaml - Content of pnpm-workspace.yaml.
 * @returns The unknown keys, in the order they appear.
 */
export function unknownWorkspaceKeys(yaml: string): string[] {
  const keys = yaml
    .split('\n')
    .map((line) => /^([A-Za-z][\w-]*)\s*:/.exec(line)?.[1])
    .filter((key) => key !== undefined);
  return keys.filter((key) => !knownWorkspaceKeys.has(key));
}

/**
 * Prepares the environment in which pnpm reports its settings.
 *
 * Inside `pnpm run`, pnpm turns off `verifyDepsBeforeRun` for its child
 * processes, so that nested calls do not check the dependencies again. That
 * inherited override is removed here, because the value set for the
 * workspace is what counts. Outside `pnpm run` the environment stays as it
 * is, and an override set by hand is reported.
 *
 * @param env - Environment of this process.
 * @returns The environment for `pnpm config list`.
 */
export function configEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env['npm_lifecycle_event'] === undefined) {
    return env;
  }
  const inherited = new Set([
    'pnpm_config_verify_deps_before_run',
    'npm_config_verify_deps_before_run',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !inherited.has(key)),
  );
}

function main(): number {
  const yaml = readFileSync(
    new URL('../pnpm-workspace.yaml', import.meta.url),
    'utf8',
  );
  const output = runPnpm(
    ['config', 'list', '--json'],
    configEnvironment(process.env),
  );
  const actual = JSON.parse(output) as Record<string, unknown>;
  const problems = [
    ...unknownWorkspaceKeys(yaml).map(
      (key) => `Unbekannte Einstellung in pnpm-workspace.yaml: ${key}`,
    ),
    ...compareSettings(actual),
  ];
  for (const problem of problems) {
    console.error(problem);
  }
  console.log(
    problems.length === 0
      ? `pnpm-Einstellungen geprüft: alle ${String(Object.keys(expectedSettings).length)} Schutzwerte sind wirksam.`
      : `pnpm-Einstellungen geprüft: ${String(problems.length)} ${problems.length === 1 ? 'Abweichung' : 'Abweichungen'}.`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
