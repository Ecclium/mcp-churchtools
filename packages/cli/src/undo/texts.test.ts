import type {
  LineDiff,
  UndoReason,
  UndoSubject,
} from '@ecclium/mcp-churchtools-core';
import type { ErrorCode } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import type { Output } from '../output/index.js';
import { isTextLine } from '../send.js';
import {
  changedLineOf,
  deletedLines,
  doneLines,
  failedEnding,
  incompleteEnding,
  undoChangedOf,
  undoUnchangedOf,
  undoUnrecordedOf,
  wouldChangeLineOf,
} from './texts.js';
import { reportUndo } from './undo.js';

// The endings of `ecclium undo` by what the core says (ADR 0031): each
// reason and each code with its exit code after sysexits, for a page, the
// change of an appointment, a new appointment and a new booking.

const subjects: readonly UndoSubject[] = [
  'page',
  'appointment',
  'newAppointment',
  'newBooking',
];

const reasons: readonly [UndoReason, number][] = [
  ['blocked', 77],
  ['readOnly', 77],
  ['switchedOff', 77],
  ['switchUnknown', 77],
  ['notRun', 77],
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
  ['calendarRight', 77],
  ['resourceRight', 77],
  ['datedFields', 65],
  ['datedSpan', 65],
  ['appointmentChanged', 65],
  ['appointmentParts', 77],
  ['wholeDays', 77],
  ['notOwnTime', 77],
  ['dayListFull', 77],
  ['bookingGone', 66],
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
  it.each(
    subjects.flatMap((subject) =>
      reasons.map(([reason, code]) => [subject, reason, code] as const),
    ),
  )('gives for %s the reason %s the code %i', (subject, reason, code) => {
    const ended = failedEnding({
      code: 'internal',
      reason,
      sent: false,
      subject,
    });
    expect(ended.code).toBe(code);
    expect(isTextLine(ended.text, 4000)).toBe(true);
  });

  it.each(
    subjects.flatMap((subject) =>
      codes.map(([error, code]) => [subject, error, code] as const),
    ),
  )(
    'gives for %s the code %s without a reason the code %i',
    (subject, error, code) => {
      expect(failedEnding({ code: error, sent: false, subject }).code).toBe(
        code,
      );
    },
  );

  it('names a page without a subject, as before a snapshot is found', () => {
    expect(failedEnding({ code: 'not_found', sent: false }).text).toBe(
      failedEnding({ code: 'not_found', sent: false, subject: 'page' }).text,
    );
  });

  it('names what the undo takes back in the texts that depend on it', () => {
    expect(
      failedEnding({
        code: 'not_found',
        sent: false,
        subject: 'newAppointment',
      }).text,
    ).toMatch(/^Den Termin gibt es in ChurchTools nicht mehr/u);
    expect(
      failedEnding({ code: 'conflict', sent: false, subject: 'appointment' })
        .text,
    ).toMatch(/^Der Termin hat sich während der Rücknahme geändert/u);
    expect(
      failedEnding({ code: 'permission', sent: false, subject: 'newBooking' })
        .text,
    ).toContain('keine Buchungen anfragen oder löschen');
    expect(
      failedEnding({ code: 'validation', sent: false, subject: 'appointment' })
        .text,
    ).toContain('die Felder der Rücknahme');
    expect(
      failedEnding({ code: 'conflict', sent: true, subject: 'newBooking' })
        .text,
    ).toContain('die Buchungsanfrage ist danach noch da');
    expect(
      failedEnding({ code: 'network', sent: true, subject: 'appointment' })
        .text,
    ).toContain('Prüfen Sie den Termin in ChurchTools');
  });

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

  it('names the place of a new page, appointment or booking without its ID', () => {
    expect(incompleteEnding('page', 12)).toMatchObject({ code: 66 });
    expect(incompleteEnding('page', 12).text).toContain('Kategorie 12');
    expect(incompleteEnding('newAppointment', 8).text).toContain(
      'den Kalender 8',
    );
    expect(incompleteEnding('newBooking', 13).text).toContain(
      'der Ressource 13',
    );
  });

  it('names the ID to take an undo back, and none after a delete', () => {
    expect(doneLines('page', 5)).toHaveLength(1);
    expect(
      doneLines('page', 5, '11111111-2222-4333-8444-555555555555')[1],
    ).toContain('ecclium undo 11111111-2222-4333-8444-555555555555');
    expect(doneLines('appointment', 3)[0]).toBe(
      'Der Schreibvorgang ist zurückgenommen, der Termin steht jetzt in Version 3.',
    );
    expect(deletedLines('newBooking')[0]).toBe(
      'Der Schreibvorgang ist zurückgenommen, die Buchungsanfrage ist gelöscht.',
    );
    expect(deletedLines('newAppointment').join(' ')).not.toContain(
      'ecclium undo',
    );
  });

  it.each(subjects)('has texts of one line for %s', (subject) => {
    const texts = [
      undoUnchangedOf(subject).text,
      undoChangedOf(subject).text,
      wouldChangeLineOf(subject),
      changedLineOf(subject),
      undoUnrecordedOf(subject).text,
      ...deletedLines(subject),
    ];
    for (const text of texts) expect(isTextLine(text, 4000)).toBe(true);
    expect(undoUnchangedOf(subject).code).toBe(0);
    expect(undoChangedOf(subject).code).toBe(65);
    expect(undoUnrecordedOf(subject).code).toBe(74);
  });

  it('never offers --overwrite for a new appointment or booking', () => {
    expect(undoChangedOf('appointment').text).toContain(
      'Mit ‹--overwrite› schreibt Ecclium trotzdem',
    );
    for (const subject of ['newAppointment', 'newBooking'] as const) {
      expect(undoChangedOf(subject).text).toContain(
        'auch nicht mit ‹--overwrite›',
      );
    }
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
      subject: 'page',
      version: 5,
      undoId: '11111111-2222-4333-8444-555555555555',
      diff,
      unrecorded: true,
    });
    expect(code).toBe(74);
    expect(stdout.at(-2)).toBe(doneLines('page', 5)[0]);
    expect(stderr).toEqual([undoUnrecordedOf('page').text]);
  });

  it('reports a delete with its diff and without an ID to take it back', () => {
    const { output, stdout, stderr } = capture();
    expect(
      reportUndo(output, { kind: 'deleted', subject: 'newBooking', diff }),
    ).toBe(0);
    expect(stdout).toEqual([
      changedLineOf('newBooking'),
      ...deletedLines('newBooking'),
    ]);
    expect(stderr).toEqual([]);
    const unrecorded = capture();
    expect(
      reportUndo(unrecorded.output, {
        kind: 'deleted',
        subject: 'newAppointment',
        diff,
        unrecorded: true,
      }),
    ).toBe(74);
    expect(unrecorded.stderr).toEqual([
      undoUnrecordedOf('newAppointment').text,
    ]);
  });

  it('shows the diff of an undo whose outcome is unknown, and only then', () => {
    const sent = capture();
    expect(
      reportUndo(sent.output, {
        kind: 'failed',
        subject: 'newAppointment',
        code: 'network',
        reason: 'unknown',
        state: 'failed',
        sent: true,
        diff,
      }),
    ).toBe(69);
    expect(sent.stdout).toEqual([wouldChangeLineOf('newAppointment')]);
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
    const page = capture();
    reportUndo(page.output, {
      kind: 'failed',
      code: 'network',
      reason: 'unknown',
      state: 'failed',
      sent: true,
      diff,
      unrecorded: true,
    });
    expect(page.stdout).toEqual([wouldChangeLineOf('page')]);
    expect(page.stderr.at(-1)).toBe(undoUnrecordedOf('page').text);
  });
});
