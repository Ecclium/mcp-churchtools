import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { jobsOf, runValues } from '../support/workflows.mts';

// The job e2e of ci.yml (ADR 0036): it runs the E2E checks of
// scripts/e2e/ with Docker Compose, outside the network namespace of the
// checks (ADR 0052). These tests read the workflow as text: the job only
// reads, has no secret and no cache, always runs, and runs the build and
// then the driver once, so that a failed proof fails the job.

const ci = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

/** The text of the job e2e in a workflow. */
const e2eOf = (workflow: string): string =>
  jobsOf(workflow).find(([job]) => job === 'e2e')?.[1] ?? '';

/** Whatever would let the job pass without its proofs. */
export function e2eViolations(workflow: string): string[] {
  const job = e2eOf(workflow);
  if (job === '') return ['Der Job e2e fehlt.'];
  const found: string[] = [];
  const permissions = /^ {4}permissions:\n((?: {6}.*\n)*)/m.exec(job)?.[1];
  if (permissions?.trim() !== 'contents: read') {
    found.push('Der Job darf mehr als lesen.');
  }
  if (!/^ {4}timeout-minutes: \d+$/m.test(job))
    found.push('Der Job hat keine Frist.');
  if (/^ {4}if:/m.test(job)) found.push('Der Job hat eine Bedingung.');
  if (/continue-on-error/.test(job)) found.push('Ein Fehler wird übergangen.');
  if (/\bsecrets\./.test(job)) found.push('Der Job nutzt ein Geheimnis.');
  if (!/persist-credentials: false/.test(job))
    found.push('Checkout behält das Token.');
  if (!/^ {10}cache: false$/m.test(job)) found.push('mise nutzt einen Cache.');
  const commands = runValues(job, 'e2e').map((command) => command.trim());
  const expected = [
    'pnpm install --frozen-lockfile',
    'git diff --exit-code',
    'pnpm run build',
    'pnpm run e2e',
    'git diff --exit-code',
  ];
  if (JSON.stringify(commands) !== JSON.stringify(expected)) {
    found.push(`Die Befehle des Jobs sind ${JSON.stringify(commands)}.`);
  }
  return found;
}

describe('the job e2e', () => {
  it('reads only, keeps no token, has no secret, no cache and no condition, and runs the driver', () => {
    expect(e2eViolations(ci)).toEqual([]);
  });

  // The job runs `pnpm run e2e`; what that runs stands in package.json, so
  // that a changed script could not make the job pass without its proofs.
  it('runs exactly the driver behind pnpm run e2e', () => {
    const scripts = (
      JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['e2e']).toBe('node scripts/e2e/run.mts');
  });

  const job = e2eOf(ci);
  it.each([
    ['no job', ci.replace(job, '')],
    [
      'a right to write',
      ci.replace(job, job.replace('contents: read', 'contents: write')),
    ],
    [
      'no limit of time',
      ci.replace(job, job.replace(/^ {4}timeout-minutes: \d+\n/m, '')),
    ],
    [
      'a condition',
      ci.replace(
        job,
        job.replace(
          '    runs-on:',
          "    if: github.event_name == 'never'\n    runs-on:",
        ),
      ),
    ],
    [
      'an ignored failure',
      ci.replace(
        job,
        job.replace(
          'run: pnpm run e2e',
          'run: pnpm run e2e\n        continue-on-error: true',
        ),
      ),
    ],
    [
      'a failure swallowed by the shell',
      ci.replace(
        job,
        job.replace('run: pnpm run e2e', 'run: pnpm run e2e || true'),
      ),
    ],
    [
      'no driver',
      ci.replace(job, job.replace('run: pnpm run e2e', 'run: echo e2e')),
    ],
    [
      'a cache of mise',
      ci.replace(job, job.replace('cache: false', 'cache: true')),
    ],
    [
      'a secret',
      ci.replace(
        job,
        job.replace(
          'run: pnpm run e2e',
          'run: pnpm run e2e\n        env:\n          TOKEN: ${{ secrets.TOKEN }}',
        ),
      ),
    ],
  ])('reports %s', (_name, changed) => {
    expect(changed).not.toBe(ci);
    expect(e2eViolations(changed)).not.toEqual([]);
  });
});
