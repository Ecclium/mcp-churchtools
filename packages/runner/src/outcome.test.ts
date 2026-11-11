import type {
  AuditRunResult,
  ContentViolationKind,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  auditEndOf,
  type RunnerSeverity,
  runnerSeverities,
  type RunOutcome,
  severityOf,
  worseOf,
} from './outcome.js';

// How the runner judges the end of a run (ADR 0033, ADR 0034): the audit
// line takes only the closed list of error codes, and a pass ends with one
// severity, which the command line turns into an exit code.

const failed = (
  code: string | undefined,
  final: boolean,
  more: Partial<RunOutcome> = {},
): RunOutcome => ({
  result: 'failed',
  step: 'write',
  ...(code === undefined ? {} : { code }),
  final,
  ...more,
});

const done: readonly AuditRunResult[] = [
  'written',
  'unchanged',
  'queued',
  'drafted',
  'preview',
];

describe('the audit end of a run', () => {
  it.each(done)('states only the result for %s', (result) => {
    // A step or a code beside a result that is no failure never reaches
    // the audit line.
    const end = auditEndOf({
      result,
      step: 'write',
      code: 'network',
      final: true,
    });
    expect(end).toEqual({ result });
    expect(Object.isFrozen(end)).toBe(true);
  });

  it.each(['run_calls_exhausted', 'run_items_exhausted', 'run_person_unknown'])(
    'turns the engine code %s into validation, not refused',
    (code) => {
      expect(auditEndOf(failed(code, true, { step: 'input' }))).toEqual({
        result: 'failed',
        step: 'input',
        code: 'validation',
      });
    },
  );

  it('refuses a breach of the content policy with a frozen copy of its reasons', () => {
    const violations: ContentViolationKind[] = ['webAddress', 'contact'];
    const end = auditEndOf(
      failed('run_content_refused', true, { step: 'content', violations }),
    );
    expect(end).toEqual({
      result: 'failed',
      step: 'content',
      code: 'validation',
      refused: true,
      contentViolations: ['webAddress', 'contact'],
    });
    expect(Object.isFrozen(end)).toBe(true);
    expect(Object.isFrozen(end.contentViolations)).toBe(true);
    // A copy: the caller cannot change the line after the fact.
    expect(end.contentViolations).not.toBe(violations);
  });

  it('refuses a breach of the content policy without reasons and states none', () => {
    const end = auditEndOf(
      failed('run_content_refused', true, { step: 'answer', violations: [] }),
    );
    expect(end).toEqual({
      result: 'failed',
      step: 'answer',
      code: 'validation',
      refused: true,
    });
  });

  it('states no reasons of the content policy for a failure that is not refused', () => {
    expect(
      auditEndOf(
        failed('run_person_unknown', true, {
          step: 'answer',
          violations: ['webAddress'],
        }),
      ),
    ).toEqual({ result: 'failed', step: 'answer', code: 'validation' });
  });

  it('refuses a final policy_denied, which a kill switch or the policy gives', () => {
    expect(auditEndOf(failed('policy_denied', true))).toEqual({
      result: 'failed',
      step: 'write',
      code: 'policy_denied',
      refused: true,
    });
  });

  it('keeps a transient policy_denied an error, since a later try may pass', () => {
    expect(auditEndOf(failed('policy_denied', false))).toEqual({
      result: 'failed',
      step: 'write',
      code: 'policy_denied',
    });
  });

  it('passes a code of the core on as it is', () => {
    expect(auditEndOf(failed('network', false))).toEqual({
      result: 'failed',
      step: 'write',
      code: 'network',
    });
  });

  it('turns a code the runner does not know, or none, into internal', () => {
    expect(auditEndOf(failed('run_something_new', true))).toEqual({
      result: 'failed',
      step: 'write',
      code: 'internal',
    });
    expect(
      auditEndOf({ result: 'failed', code: 'not a code', final: true }),
    ).toEqual({ result: 'failed', code: 'internal' });
    // No code and no step: a fault of the runner itself.
    expect(auditEndOf({ result: 'failed', final: true })).toEqual({
      result: 'failed',
      code: 'internal',
    });
  });
});

describe('the severity of a run', () => {
  it.each(done)('is ok for %s', (result) => {
    expect(severityOf({ result, final: true })).toBe('ok');
  });

  it('is file for a failure in a file of the runner, before any other reason', () => {
    expect(severityOf(failed('internal', false, { file: true }))).toBe('file');
    expect(severityOf(failed('internal', true, { file: true }))).toBe('file');
  });

  it('is temporary for any failure a later try may pass', () => {
    for (const code of [
      'network',
      'rate_limited',
      'policy_denied',
      'internal',
    ]) {
      expect(severityOf(failed(code, false))).toBe('temporary');
    }
  });

  it('is internal for a final internal failure and an unknown code', () => {
    expect(severityOf(failed('internal', true))).toBe('internal');
    expect(severityOf(failed('run_something_new', true))).toBe('internal');
    expect(severityOf({ result: 'failed', final: true })).toBe('internal');
  });

  it('is config for a configuration that does not fit', () => {
    expect(severityOf(failed('config', true))).toBe('config');
  });

  it.each([
    'auth',
    'permission',
    'policy_denied',
    'license_required',
    'confirmation_required',
  ])('is refused for a final %s', (code) => {
    expect(severityOf(failed(code, true))).toBe('refused');
  });

  it.each([
    'validation',
    'not_found',
    'conflict',
    'run_content_refused',
    'run_person_unknown',
    'run_calls_exhausted',
    'run_items_exhausted',
  ])('is data for a final %s', (code) => {
    expect(severityOf(failed(code, true))).toBe('data');
  });
});

describe('the worse of two severities', () => {
  it('lists the severities from none to the worst, frozen', () => {
    expect(runnerSeverities).toEqual([
      'ok',
      'temporary',
      'file',
      'data',
      'refused',
      'config',
      'internal',
    ]);
    expect(Object.isFrozen(runnerSeverities)).toBe(true);
  });

  it('is the later one in that list, whichever comes first', () => {
    runnerSeverities.forEach((left: RunnerSeverity, i) => {
      runnerSeverities.forEach((right: RunnerSeverity, j) => {
        expect(worseOf(left, right)).toBe(runnerSeverities[Math.max(i, j)]);
      });
    });
    expect(worseOf('temporary', 'refused')).toBe('refused');
    expect(worseOf('refused', 'temporary')).toBe('refused');
    expect(worseOf('file', 'file')).toBe('file');
  });
});
