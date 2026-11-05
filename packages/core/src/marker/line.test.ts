import { isIsoDate, type IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalMarkdown,
  checkMarkdown,
  checkPlainText,
} from '../content/index.js';
import type { MarkingOrigin } from './code.js';
import { type Marking, markingLineOf, readMarkingLine } from './line.js';

const dayOf = (value: string): IsoDate => {
  if (!isIsoDate(value)) throw new TypeError('No day.');
  return value;
};

const day = dayOf('2026-11-05');
const code = 'k1:ABCDEFGHIJKLM';
const interactive: Marking = {
  date: day,
  origin: { kind: 'interactive', day },
  code,
};
const routine: Marking = {
  date: dayOf('2026-09-28'),
  origin: { kind: 'routine', routine: 'dienstplan-report', run: '2026-W40' },
  code,
};

describe('markingLineOf', () => {
  // The wording of brand/README.md, chapter 9, and its interactive form
  // (ADR 0032).
  it('writes the fixed wording of the brand', () => {
    expect(markingLineOf(interactive, 'Sekretariat')).toBe(
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    );
    expect(markingLineOf(routine, 'Sekretariat')).toBe(
      'Automatisch erstellt am 28.09.2026 durch Ecclium, Routine dienstplan-report, Lauf 2026-W40, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    );
  });

  it('adds no second full stop after a sentence the operator ends', () => {
    for (const end of ['.', '!', '?']) {
      expect(
        markingLineOf(interactive, `Sekretariat${end}`).endsWith(
          `Rückfragen an Sekretariat${end}`,
        ),
      ).toBe(true);
    }
  });

  it('escapes the text of the operator like every text it writes', () => {
    expect(markingLineOf(interactive, 'Team *Wiki* & Co')).toBe(
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Team \\*Wiki\\* \\& Co.',
    );
  });

  it('refuses a marking of another form and an empty or broken text of the operator', () => {
    const bad: readonly [Marking, string][] = [
      [{ ...interactive, date: '2026-02-30' as IsoDate }, 'Sekretariat'],
      [{ ...interactive, code: 'k1:abcdefghijklm' }, 'Sekretariat'],
      [{ ...interactive, code: 'k2:ABCDEFGHIJKLM' }, 'Sekretariat'],
      [
        {
          ...interactive,
          origin: { kind: 'interactive', day: dayOf('2026-11-06') },
        },
        'Sekretariat',
      ],
      [
        {
          ...routine,
          origin: { kind: 'routine', routine: 'Dienstplan', run: 'x' },
        },
        'Sekretariat',
      ],
      [
        { ...routine, origin: { kind: 'routine', routine: 'a', run: 'a b' } },
        'Sekretariat',
      ],
      [interactive, ''],
      [interactive, '   '],
      [interactive, 'Sekretariat\noder Pfarramt'],
      [interactive, `Sekretariat${String.fromCodePoint(0x2028)}Pfarramt`],
    ];
    for (const [marking, inquiriesTo] of bad) {
      expect(() => markingLineOf(marking, inquiriesTo)).toThrow(TypeError);
    }
  });

  // A page that carries the line can still be changed: the content policy
  // takes it as it is, and its canonical form is the line itself.
  it('writes a line the content policy takes unchanged', () => {
    const line = markingLineOf(interactive, 'Team *Wiki*');
    expect(checkMarkdown(line, { contacts: new Set() })).toEqual({
      ok: true,
      text: `${line}\n`,
    });
    expect(canonicalMarkdown(line)).toBe(`${line}\n`);
  });
});

describe('readMarkingLine', () => {
  it('reads both forms', () => {
    expect(readMarkingLine(markingLineOf(interactive, 'Sekretariat'))).toEqual(
      interactive,
    );
    expect(readMarkingLine(markingLineOf(routine, 'Sekretariat'))).toEqual(
      routine,
    );
  });

  it('takes spaces at the end, decomposed umlauts and a link after Rückfragen an', () => {
    const line = markingLineOf(interactive, 'sekretariat@example.org');
    expect(readMarkingLine(`${line}  `)).toEqual(interactive);
    expect(readMarkingLine(line.normalize('NFD'))).toEqual(interactive);
    expect(
      readMarkingLine(
        line.replace(
          'sekretariat@example.org.',
          '[sekretariat@example.org](mailto:sekretariat@example.org).',
        ),
      ),
    ).toEqual(interactive);
  });

  it.each([
    [
      'another wording',
      'Automatisch erzeugt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'a code in lower case',
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:abcdefghijklm. Rückfragen an Sekretariat.',
    ],
    [
      'another prefix',
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k2:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'a short code',
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKL. Rückfragen an Sekretariat.',
    ],
    [
      'a day that does not exist',
      'Automatisch erstellt am 30.02.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'a day before 1970',
      'Automatisch erstellt am 31.12.1969 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'text before it',
      'Siehe: Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'nobody to ask',
      'Automatisch erstellt am 05.11.2026 durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an ',
    ],
    [
      'a routine in capitals',
      'Automatisch erstellt am 28.09.2026 durch Ecclium, Routine Dienstplan, Lauf 2026-W40, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
    [
      'a routine without a run',
      'Automatisch erstellt am 28.09.2026 durch Ecclium, Routine dienstplan-report, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.',
    ],
  ])('refuses %s', (_name, line) => {
    expect(readMarkingLine(line)).toBeUndefined();
  });

  // Generated texts of the operator (ADR 0070): whatever passes the
  // content policy as plain text reads back as the same marking.
  it('reads back every line it writes', () => {
    const origin = fc.oneof(
      fc.constant<MarkingOrigin>({ kind: 'interactive', day }),
      fc
        .tuple(
          fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
          fc.stringMatching(/^[0-9A-Za-z][0-9A-Za-z-]{0,10}$/),
        )
        .map(([name, run]): MarkingOrigin => ({
          kind: 'routine',
          routine: name,
          run,
        })),
    );
    fc.assert(
      fc.property(
        origin,
        fc.string({ minLength: 1, maxLength: 60 }),
        (from, inquiries) => {
          const checked = checkPlainText(inquiries, { contacts: new Set() });
          fc.pre(checked.ok && checked.text.trim() !== '');
          const marking: Marking = {
            date: from.kind === 'interactive' ? from.day : day,
            origin: from,
            code,
          };
          expect(readMarkingLine(markingLineOf(marking, checked.text))).toEqual(
            marking,
          );
        },
      ),
      { seed: 32_010, numRuns: 400 },
    );
  });
});
