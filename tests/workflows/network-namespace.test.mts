import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { jobsOf } from '../support/workflows.mts';

// Build and checks of the jobs check, compat and minimum, and the tests with
// coverage of coverage-security-core, run in a network namespace with
// loopback only (ADR 0052). These tests read the workflows
// and the wrapper as text, run shellcheck over the wrapper, and in CI check
// from inside the namespace that only loopback is there. A text check sees
// only the spellings it knows; the review sees the rest.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const wrapper = 'scripts/ci/without-network.sh';
const wrapped = `bash ${wrapper} pnpm run ci:check`;
const wrappedCoverage = `bash ${wrapper} pnpm run ci:coverage`;
// Each job of ci.yml that must run the checks or the tests, with the one
// wrapped command it runs.
const checkJobs: Readonly<Record<string, string>> = {
  check: wrapped,
  compat: wrapped,
  minimum: wrapped,
  'coverage-security-core': wrappedCoverage,
};
// Any way to run the checks or the tests of the repository.
const runsChecks =
  /\bci:(?:check|coverage)\b|\bpnpm\s+(?:run\s+)?(?:check|test|coverage:security)\b|\bvitest\b/;

// GitHub runs workflow files ending in .yml and .yaml alike.
export const workflowFile = /\.ya?ml$/;

const read = (path: string): string =>
  readFileSync(join(workspace, path), 'utf8');

const workflows = (): (readonly [string, string])[] =>
  readdirSync(join(workspace, '.github/workflows'))
    .filter((name) => workflowFile.test(name))
    .map((name) => [name, read(`.github/workflows/${name}`)] as const);

/** The steps of a job, split at the dash of each step. */
const stepsOf = (job: string): string[] =>
  job.split(/^(?= {6}- )/m).filter((step) => step.startsWith('      - '));

/**
 * Every way a workflow could run the checks with network: a step that runs
 * them without the wrapper, a wrapped step that can be skipped or ignored
 * or lets mise go online, or a check job without the wrapped step.
 */
export function namespaceViolations(
  files: readonly (readonly [string, string])[],
): string[] {
  const found: string[] = [];
  for (const [name, text] of files) {
    const jobs = jobsOf(text);
    if (name === 'ci.yml') {
      for (const job of Object.keys(checkJobs)) {
        if (!jobs.some(([present]) => present === job)) {
          found.push(`${name} ${job}: the job is missing`);
        }
      }
    }
    for (const [job, body] of jobs) {
      const where = `${name} ${job}`;
      let wrappedSteps = 0;
      for (const step of stepsOf(body)) {
        const run = /^ {6}(?:- | {2})run: (.*)$/m.exec(step)?.[1] ?? '';
        const block = /^ {6}(?:- | {2})run: [|>]/m.test(step);
        if (!block && !runsChecks.test(run)) continue;
        if (block && !runsChecks.test(step)) continue;
        if (run !== wrapped && run !== wrappedCoverage) {
          found.push(`${where}: runs the checks with network`);
          continue;
        }
        if (
          name === 'ci.yml' &&
          Object.hasOwn(checkJobs, job) &&
          run !== checkJobs[job]
        ) {
          found.push(`${where}: runs other checks than its own`);
        }
        wrappedSteps += 1;
        if (!/^ {10}MISE_OFFLINE: 1$/m.test(step)) {
          found.push(`${where}: mise may go online in the namespace`);
        }
        if (/^ {8}(if|continue-on-error):/m.test(step)) {
          found.push(
            `${where}: the step without network can be skipped or ignored`,
          );
        }
      }
      if (
        name === 'ci.yml' &&
        Object.hasOwn(checkJobs, job) &&
        wrappedSteps !== 1
      ) {
        found.push(
          `${where}: needs exactly one step that runs the checks without network`,
        );
      }
    }
  }
  return found;
}

/**
 * Every way the wrapper could run the command with network or ignore a
 * failure: without strict mode, without the probes in their places, with
 * the sysctl outside a GitHub runner, without stopping Docker on a GitHub
 * runner before the namespace, or without failing at the end.
 */
export function wrapperViolations(text: string): string[] {
  const found: string[] = [];
  const at = (needle: string): number => text.indexOf(needle);
  if (!text.startsWith('#!/usr/bin/env bash\n'))
    found.push('not a bash script');
  const strict = at('\nset -euo pipefail\n');
  if (strict === -1 || strict > at('\nscript='))
    found.push('no strict mode first');
  if (/\|\|\s*true\b|\bset \+e\b/.test(text)) found.push('ignores a failure');
  const inside = at('if [ "${1:-}" = --inside ]; then');
  const offline = at('node "$probe" offline');
  const marker = at('export ECCLIUM_NETNS=loopback-only');
  const run = at('exec "$@"');
  if (
    inside === -1 ||
    !(inside < offline && offline < marker && marker < run)
  ) {
    found.push('the probe inside does not run before the command');
  }
  const online = at('node "$probe" online');
  if (online === -1 || online > at('if way_b; then')) {
    found.push('no probe before the namespace');
  }
  if (
    !/\[ "\$\{RUNNER_ENVIRONMENT:-\}" = github-hosted \] && \[ "\$before" = 1 \]; then\n\s+sudo sysctl/.test(
      text,
    )
  ) {
    found.push('the restriction is lifted outside a GitHub runner');
  }
  const dockerStop =
    /\n\s*if \[ "\$\{RUNNER_ENVIRONMENT:-\}" = github-hosted \] && \[ -e "\$docker_socket" \]; then\n\s+if ! sudo systemctl stop docker\.socket docker\.service; then\n[^\n]*\n\s+exit 1\n/.exec(
      text,
    );
  if (
    dockerStop === null ||
    dockerStop.index < online ||
    dockerStop.index > at('if way_b; then')
  ) {
    found.push('Docker does not stop on a GitHub runner before the namespace');
  }
  if (!text.trimEnd().endsWith("laufen nicht'\nexit 1")) {
    found.push('does not fail without a namespace');
  }
  return found;
}

describe('the network namespace of the check jobs', () => {
  it('runs the checks of check, compat, minimum and coverage-security-core only without network', () => {
    expect(namespaceViolations(workflows())).toEqual([]);
  });

  const ci = read('.github/workflows/ci.yml');
  const compat = jobsOf(ci).find(([job]) => job === 'compat')?.[1] ?? '';
  const coverage =
    jobsOf(ci).find(([job]) => job === 'coverage-security-core')?.[1] ?? '';

  it.each([
    [
      'a plain run of the checks',
      ci.replaceAll(`run: ${wrapped}`, 'run: pnpm run ci:check'),
    ],
    [
      'one job without the wrapper',
      ci.replace(
        compat,
        compat.replace(`run: ${wrapped}`, 'run: pnpm run ci:check'),
      ),
    ],
    [
      'the coverage job without the wrapper',
      ci.replace(
        coverage,
        coverage.replace(
          `run: ${wrappedCoverage}`,
          'run: pnpm run ci:coverage',
        ),
      ),
    ],
    [
      'the coverage job without coverage',
      ci.replace(
        coverage,
        coverage.replace(`run: ${wrappedCoverage}`, `run: ${wrapped}`),
      ),
    ],
    [
      'a check job that runs the coverage instead',
      ci.replace(
        compat,
        compat.replace(`run: ${wrapped}`, `run: ${wrappedCoverage}`),
      ),
    ],
    ['no coverage job', ci.replace(coverage, '')],
    [
      'tests with coverage in another job',
      ci.replace(
        '        run: actionlint',
        '        run: pnpm run coverage:security\n      - name: Lint\n        run: actionlint',
      ),
    ],
    [
      'mise online in the namespace',
      ci.replaceAll('          MISE_OFFLINE: 1\n', ''),
    ],
    [
      'a condition on the step',
      ci.replaceAll(
        '        env:\n          MISE_OFFLINE: 1\n',
        "        if: github.event_name == 'never'\n        env:\n          MISE_OFFLINE: 1\n",
      ),
    ],
    [
      'an ignored failure',
      ci.replaceAll(
        '        env:\n          MISE_OFFLINE: 1\n',
        '        continue-on-error: true\n        env:\n          MISE_OFFLINE: 1\n',
      ),
    ],
    [
      'a failure swallowed by the shell',
      ci.replaceAll(`run: ${wrapped}`, `run: ${wrapped} || true`),
    ],
    [
      'tests in another job',
      ci.replace(
        '        run: actionlint',
        '        run: pnpm test\n      - name: Lint\n        run: actionlint',
      ),
    ],
    [
      'a step that starts with run',
      ci.replace(
        '        run: actionlint',
        '        run: actionlint\n      - run: pnpm test',
      ),
    ],
    [
      'a folded command',
      ci.replace(
        '        run: actionlint',
        '        run: actionlint\n      - name: Test\n        run: >-\n          pnpm test',
      ),
    ],
  ])('reports %s', (_name, changed) => {
    expect(changed).not.toBe(ci);
    expect(namespaceViolations([['ci.yml', changed]])).not.toEqual([]);
  });

  it('reads workflow files ending in .yml and .yaml', () => {
    expect(
      ['ci.yml', 'tests.yaml', 'notes.md'].filter((name) =>
        workflowFile.test(name),
      ),
    ).toEqual(['ci.yml', 'tests.yaml']);
  });

  const script = read(wrapper);

  it('takes the network away before the command and never ignores a failure', () => {
    expect(wrapperViolations(script)).toEqual([]);
  });

  const dockerGuard =
    '[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ -e "$docker_socket" ]';
  // The whole block that stops Docker, up to its closing fi at the margin.
  const dockerBlock =
    /\nif \[ "\$\{RUNNER_ENVIRONMENT:-\}" = github-hosted \] && \[ -e "\$docker_socket" \]; then\n[\s\S]*?\nfi\n/.exec(
      script,
    )?.[0] ?? '';
  // The wrapper with that block moved in front of a line. It throws when the
  // line is gone, so that a case never tests a wrapper without the block.
  const dockerMovedBefore = (line: string): string => {
    const rest = script.replace(dockerBlock, '\n');
    if (!rest.includes(line)) throw new Error(`no line ${line} in the wrapper`);
    return rest.replace(line, () => `${dockerBlock.slice(1)}${line}`);
  };

  it.each([
    [
      'without strict mode',
      script.replace('\nset -euo pipefail\n', '\n'),
      'no strict mode first',
    ],
    [
      'with the probe inside after the command',
      script
        .replace('  node "$probe" offline\n', '')
        .replace('  exec "$@"\n', '  exec "$@"\n  node "$probe" offline\n'),
      'the probe inside does not run before the command',
    ],
    [
      'with a probe whose failure is ignored',
      script.replace('node "$probe" offline', 'node "$probe" offline || true'),
      'ignores a failure',
    ],
    [
      'without the probe before the namespace',
      script.replace('node "$probe" online\n', ''),
      'no probe before the namespace',
    ],
    [
      'with the sysctl on every machine',
      script.replace(
        '[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ "$before" = 1 ]',
        '[ "$before" = 1 ]',
      ),
      'the restriction is lifted outside a GitHub runner',
    ],
    [
      'stopping Docker on every machine',
      script.replace(dockerGuard, '[ -e "$docker_socket" ]'),
      'Docker does not stop on a GitHub runner before the namespace',
    ],
    [
      'stopping the service of Docker but not its socket',
      script.replace(
        'sudo systemctl stop docker.socket docker.service',
        'sudo systemctl stop docker.service',
      ),
      'Docker does not stop on a GitHub runner before the namespace',
    ],
    [
      'going on when Docker does not stop',
      script.replace(
        /(stoppen, die Prüfungen laufen nicht'\n)\s+exit 1\n/,
        '$1',
      ),
      'Docker does not stop on a GitHub runner before the namespace',
    ],
    [
      'stopping Docker before the probe that shows the network',
      dockerMovedBefore('node "$probe" online\n'),
      'Docker does not stop on a GitHub runner before the namespace',
    ],
    [
      'stopping Docker only after the namespace',
      dockerMovedBefore("report error 'Netzsperre' 'Netzsperre: kein"),
      'Docker does not stop on a GitHub runner before the namespace',
    ],
    [
      'ending well without a namespace',
      script.replace(/exit 1\n$/, 'exit 0\n'),
      'does not fail without a namespace',
    ],
  ])('reports a wrapper %s', (_name, changed, violation) => {
    expect(dockerBlock).not.toBe('');
    expect(changed).not.toBe(script);
    expect(wrapperViolations(changed)).toContain(violation);
  });

  it('passes shellcheck', () => {
    const result = spawnSync('mise', ['exec', '--', 'shellcheck', wrapper], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  // Only in CI: the tests of the check jobs run inside the namespace.
  it.runIf(process.env['GITHUB_ACTIONS'] === 'true')(
    'runs inside the network namespace in CI and sees only loopback',
    () => {
      expect(process.env['ECCLIUM_NETNS']).toBe('loopback-only');
      expect(Object.keys(os.networkInterfaces())).toEqual(['lo']);
    },
  );
});
