import type { LineDiff, UndoReason } from '@ecclium/mcp-churchtools-core';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import type { Output } from '../output/index.js';
import { isTextLine } from '../send.js';
import {
  doneLines,
  failedEnding,
  incompleteEnding,
  undoUnrecorded,
} from './texts.js';
import { reportUndo } from './undo.js';

// The endings of `ecclium undo` by what the core says (ADR 0031): each
// reason and each code with its exit code after sysexits.

const reasons: readonly [UndoReason, number][] = [
  ['blocked', 77],
  ['readOnly', 77],
  ['switchedOff', 77],
  ['switchUnknown', 77],
  ['notRun', 70],
  ['intent', 70],
  ['blank', 65],
  ['rightsUnknown', 77],
  ['missingRight', 77],
  ['notMarkdown', 77],
  ['changedBefore', 65],
  ['changedSincePlan', 65],
  ['clock', 77],
  ['notSent', 69],
  ['unknown', 69],
  ['notAsPlanned', 69],
  ['notConfirmed', 70],
  ['noSnapshot', 74],
  ['auditNotReady', 74],
];

const codes: readonly [ErrorCode, number][] = [
  ['auth', 77],
  ['permission', 77],
  ['not_found', 66],
  ['conflict', 65],
  ['validation', 65],
  ['network', 69],
  ['upstream', 69],
  ['rate_limited', 69],
  ['policy_denied', 77],
  ['internal', 70],
  ['config', 70],
];

describe('the endings of an undo', () => {
  it.each(reasons)('gives the reason %s the code %i', (reason, code) => {
    const ended = failedEnding({ code: 'internal', reason, sent: false });
    expect(ended.code).toBe(code);
    expect(isTextLine(ended.text, 4000)).toBe(true);
  });

  it.each(codes)(
    'gives the code %s without a reason the code %i',
    (error, code) => {
      expect(failedEnding({ code: error, sent: false }).code).toBe(code);
    },
  );

  // ChurchTools answered and refused: the sentence says the write did not
  // land, the code says why.
  it.each([
    ['auth', 77],
    ['permission', 77],
    ['not_found', 66],
    ['conflict', 65],
    ['validation', 65],
  ] as const)(
    'names a refusal %s of ChurchTools by its code, not as not reached',
    (error, code) => {
      expect(
        failedEnding({ code: error, reason: 'notSent', sent: false }).code,
      ).toBe(code);
    },
  );

  it('keeps not reached for a write that never left', () => {
    expect(
      failedEnding({ code: 'network', reason: 'notSent', sent: false }).code,
    ).toBe(69);
  });

  it('gives an unknown outcome or one not as planned for a write that may have landed', () => {
    expect(failedEnding({ code: 'network', sent: true }).code).toBe(69);
    expect(failedEnding({ code: 'conflict', sent: true }).text).toContain(
      'liest sich danach nicht wie geplant',
    );
  });

  it('names the category of a new page without its GUID, and the ID to take the undo back', () => {
    expect(incompleteEnding(12)).toMatchObject({ code: 66 });
    expect(incompleteEnding(12).text).toContain('Kategorie 12');
    expect(doneLines(5)).toHaveLength(1);
    expect(doneLines(5, '11111111-2222-4333-8444-555555555555')[1]).toContain(
      'ecclium undo 11111111-2222-4333-8444-555555555555',
    );
  });
});

describe('the report of an undo', () => {
  const capture = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output: Output = {
      stdout: (text) => {
        stdout.push(text);
        return true;
      },
      stderr: (text) => {
        stderr.push(text);
        return true;
      },
    };
    return { output, stdout, stderr };
  };
  const diff: LineDiff = { hunks: [], replaced: false };

  it('ends with 74 after an undo that wrote without its line in the audit file', () => {
    const { output, stdout, stderr } = capture();
    const code = reportUndo(output, {
      kind: 'done',
      version: 5,
      undoId: '11111111-2222-4333-8444-555555555555',
      diff,
      unrecorded: true,
    });
    expect(code).toBe(74);
    expect(stdout.at(-2)).toBe(doneLines(5)[0]);
    expect(stderr).toEqual([undoUnrecorded.text]);
  });

  it('shows the diff of an undo whose outcome is unknown, and only then', () => {
    const sent = capture();
    expect(
      reportUndo(sent.output, {
        kind: 'failed',
        code: 'network',
        reason: 'unknown',
        state: 'failed',
        sent: true,
        diff,
      }),
    ).toBe(69);
    expect(sent.stdout).toHaveLength(1);
    const refused = capture();
    expect(
      reportUndo(refused.output, {
        kind: 'failed',
        code: 'policy_denied',
        reason: 'clock',
        state: 'denied',
        sent: false,
        diff,
      }),
    ).toBe(77);
    expect(refused.stdout).toEqual([]);
  });
});
