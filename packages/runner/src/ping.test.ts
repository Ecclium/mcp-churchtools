import { dueLimits } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import type { RunnerSeverity, RunOutcome } from './outcome.js';
import type { RoutineReport, RoutineStatus } from './pass.js';
import { pingOf } from './ping.js';

// The ping of a pass (ADR 0009): which reports send nothing, a success or
// a failure. Every status of a routine and every kind of ending of a run.

const report = (
  status: RoutineStatus,
  severity: RunnerSeverity = 'ok',
  more: Partial<RoutineReport> = {},
): RoutineReport =>
  Object.freeze({ routineId: 'r', status, severity, ...more });

const outcome = (more: Partial<RunOutcome> = {}): RunOutcome =>
  Object.freeze({ result: 'written', final: true, ...more });

const ran = (
  severity: RunnerSeverity,
  ending: Partial<RunOutcome>,
  attempt?: number,
): RoutineReport =>
  report('ran', severity, {
    outcome: outcome(ending),
    ...(attempt === undefined ? {} : { attempt }),
  });

const temporary = { result: 'failed', final: false, code: 'network' } as const;

// No routine that does not start, no halt of writes.
const calm = { refused: 0, halted: false } as const;

describe('pingOf', () => {
  it('sends nothing for a pass in which nothing was due', () => {
    expect(pingOf([], calm)).toBeUndefined();
    expect(
      pingOf(
        [report('not_due'), report('stopped'), report('busy', 'temporary')],
        calm,
      ),
    ).toBeUndefined();
  });

  it('sends nothing for refused routines alone, without a pass that ran', () => {
    expect(
      pingOf([report('not_due')], { refused: 2, halted: false }),
    ).toBeUndefined();
  });

  it.each(['written', 'unchanged', 'queued', 'drafted', 'preview'] as const)(
    'reports a success for a run that ended %s',
    (result) => {
      expect(pingOf([ran('ok', { result }), report('not_due')], calm)).toBe(
        'success',
      );
    },
  );

  it.each([
    ['for good', ran('data', { result: 'failed', final: true })],
    ['with a refusal', ran('refused', { result: 'failed', final: true })],
    ['in a file of the runner', ran('file', { result: 'failed', final: true })],
    ['for a passing reason at its second try', ran('temporary', temporary, 2)],
    [
      'for a passing reason at its last try',
      ran('temporary', temporary, dueLimits.maxTries),
    ],
    ['for a passing reason by hand', ran('temporary', temporary)],
  ] as const)('reports a failure for a run that failed %s', (_case, item) => {
    expect(pingOf([item], calm)).toBe('fail');
  });

  it('reports a failure for a run that wrote but whose notice or audit line failed', () => {
    expect(pingOf([ran('file', { result: 'written' })], calm)).toBe('fail');
    expect(pingOf([ran('temporary', { result: 'written' }, 1)], calm)).toBe(
      'fail',
    );
  });

  it.each(['halted', 'read_only', 'lock_failed', 'not_opened', 'internal'])(
    'reports a failure for a due routine that could not begin its run: %s',
    (status) => {
      expect(
        pingOf(
          [report(status as RoutineStatus, 'config'), ran('ok', {})],
          calm,
        ),
      ).toBe('fail');
    },
  );

  it('sends nothing after the first try of a trigger that failed for a passing reason', () => {
    expect(pingOf([ran('temporary', temporary, 1)], calm)).toBeUndefined();
    expect(
      pingOf([ran('temporary', temporary, 1), ran('ok', {})], calm),
    ).toBeUndefined();
    expect(pingOf([report('unavailable', 'temporary')], calm)).toBeUndefined();
  });

  it('reports a failure while a routine of the runner does not start', () => {
    const refused = { refused: 1, halted: false };
    expect(pingOf([ran('ok', {})], refused)).toBe('fail');
    expect(pingOf([ran('temporary', temporary, 1)], refused)).toBe('fail');
  });

  // A halt of writes makes a refused write a passing failure at its first
  // try, and the daemon ends after the pass (ADR 0029).
  it('reports a failure while writes of the process are halted', () => {
    const halted = { refused: 0, halted: true };
    expect(pingOf([ran('temporary', temporary, 1)], halted)).toBe('fail');
    expect(pingOf([ran('ok', {})], halted)).toBe('fail');
    expect(pingOf([], halted)).toBe('fail');
  });

  it('lets a failure win over a success and over another try', () => {
    expect(
      pingOf(
        [
          ran('ok', {}),
          ran('temporary', temporary, 1),
          ran('data', { result: 'failed', final: true }),
        ],
        calm,
      ),
    ).toBe('fail');
  });
});
