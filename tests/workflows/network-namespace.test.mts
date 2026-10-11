import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { jobsOf } from '../support/workflows.mts';

// Build and checks of the jobs check, compat and minimum run in a network
// namespace with loopback only (ADR 0052). These tests read the workflows
// and the wrapper as text, run shellcheck over the wrapper, and in CI check
// from inside the namespace that only loopback is there. A text check sees
// only the spellings it knows; the review sees the rest.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const wrapper = 'scripts/ci/without-network.sh';
const wrapped = `bash ${wrapper} pnpm run ci:check`;
const checkJobs: readonly string[] = ['check', 'compat', 'minimum'];
// Any way to run the checks or the tests of the repository.
const runsChecks =
  /\bci:check\b|\bpnpm\s+(?:run\s+)?(?:check|test)\b|\bvitest\b/;

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
    for (const [job, body] of jobsOf(text)) {
      const where = `${name} ${job}`;
      let wrappedSteps = 0;
      for (const step of stepsOf(body)) {
        const run = /^ {6}(?:- | {2})run: (.*)$/m.exec(step)?.[1] ?? '';
        const block = /^ {6}(?:- | {2})run: [|>]/m.test(step);
        if (!block && !runsChecks.test(run)) continue;
        if (block && !runsChecks.test(step)) continue;
        if (run !== wrapped) {
          found.push(`${where}: runs the checks with network`);
          continue;
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
      if (name === 'ci.yml' && checkJobs.includes(job) && wrappedSteps !== 1) {
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
 * the sysctl outside a GitHub runner, or without failing at the end.
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
  if (!text.trimEnd().endsWith("laufen nicht'\nexit 1")) {
    found.push('does not fail without a namespace');
  }
  return found;
}

describe('the network namespace of the check jobs', () => {
  it('runs the checks of check, compat and minimum only without network', () => {
    expect(namespaceViolations(workflows())).toEqual([]);
  });

  const ci = read('.github/workflows/ci.yml');
  const compat = jobsOf(ci).find(([job]) => job === 'compat')?.[1] ?? '';

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

  it.each([
    ['without strict mode', script.replace('\nset -euo pipefail\n', '\n')],
    [
      'with the probe inside after the command',
      script
        .replace('  node "$probe" offline\n', '')
        .replace('  exec "$@"\n', '  exec "$@"\n  node "$probe" offline\n'),
    ],
    [
      'with a probe whose failure is ignored',
      script.replace('node "$probe" offline', 'node "$probe" offline || true'),
    ],
    [
      'without the probe before the namespace',
      script.replace('node "$probe" online\n', ''),
    ],
    [
      'with the sysctl on every machine',
      script.replace('[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && ', ''),
    ],
    [
      'ending well without a namespace',
      script.replace(/exit 1\n$/, 'exit 0\n'),
    ],
  ])('reports a wrapper %s', (_name, changed) => {
    expect(changed).not.toBe(script);
    expect(wrapperViolations(changed)).not.toEqual([]);
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
