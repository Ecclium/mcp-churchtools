import { isIsoDate, type IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { canonicalMarkdown, checkMarkdown } from '../content/index.js';
import { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, type MarkingOrigin, sameCheckCode } from './code.js';
import { type Marking, markingLineOf } from './line.js';
import {
  findMarkings,
  judgeSections,
  maxMarkings,
  maxSectionStarts,
} from './sections.js';

const key = new KeyMaterial('0123456789abcdef'.repeat(4));
const otherKey = new KeyMaterial('fedcba9876543210'.repeat(4));
const tenantId = 'default';

const dayOf = (value: string): IsoDate => {
  if (!isIsoDate(value)) throw new TypeError('No day.');
  return value;
};
const day = dayOf('2026-11-05');
const interactive: MarkingOrigin = { kind: 'interactive', day };

// A section as the core writes it: the written form of the content
// policy, an empty line and the line of the marking.
const own = (
  section: string,
  origin: MarkingOrigin = interactive,
  signWith = key,
): { readonly text: string; readonly code: string } => {
  const written = checkMarkdown(section, { contacts: new Set() });
  if (!written.ok) throw new TypeError('The section does not pass.');
  const canonical = canonicalMarkdown(written.text);
  if (canonical === undefined) throw new TypeError('No canonical form.');
  const code = checkCodeOf(signWith, tenantId, origin, canonical);
  const date = origin.kind === 'interactive' ? origin.day : day;
  const line = markingLineOf({ date, origin, code }, 'Sekretariat');
  return { text: `${written.text}\n${line}\n`, code };
};

const judge = (text: string, code?: string) =>
  judgeSections({
    key,
    tenantId,
    text,
    matches: (marking: Marking) =>
      code === undefined || sameCheckCode(marking.code, code),
  });

const lineOf = (text: string, part: string): number =>
  text.split('\n').findIndex((line) => line.startsWith(part));

const report = [
  '## Dienstplan',
  '',
  'Am **Sonntag** spielen *zwei* Gruppen.',
  'Die Probe beginnt um 18 Uhr.',
  '',
  '- Einsingen',
  '- Notenmappe',
  '  - mit Bleistift',
  '',
  '* Stern',
  '',
  '| Stimme | Anzahl |',
  '| :-- | --: |',
  '| Sopran | 4 |',
  '| Bass | 2 |',
].join('\n');

describe('judgeSections', () => {
  it('finds a new page of its own from its first line', () => {
    const { text, code } = own(report);
    expect(judge(text, code)).toEqual({
      kind: 'own',
      start: 0,
      end: lineOf(text, 'Automatisch'),
    });
  });

  it('finds a section of its own after the text of a person', () => {
    const { text, code } = own(report);
    const page = `# Seite\n\nVon Hand geschrieben.\n\n${text}`;
    expect(judge(page, code)).toEqual({
      kind: 'own',
      start: lineOf(page, '## Dienstplan'),
      end: lineOf(page, 'Automatisch'),
    });
  });

  // What the web editor changed when it saved a page written over the API
  // (F13): the signs before list items, blank lines, the alignment of a
  // table, the way of a line break, and line endings.
  it.each([
    [
      'other signs before the list items',
      (text: string) =>
        text
          .split('\n')
          .map((line) =>
            line.startsWith('- ')
              ? `* ${line.slice(2)}`
              : line.startsWith('* ')
                ? `- ${line.slice(2)}`
                : line,
          )
          .join('\n'),
    ],
    ['more blank lines', (text: string) => text.replaceAll('\n\n', '\n\n\n')],
    [
      'a table aligned anew',
      (text: string) =>
        text
          .split('\n')
          .map((line) =>
            line.startsWith('|')
              ? line.replaceAll(' | ', '   |   ').replace('| :-- ', '|:-----')
              : line,
          )
          .join('\n'),
    ],
    [
      'the lines of a paragraph joined',
      (text: string) =>
        text.replace('Gruppen.\nDie Probe', 'Gruppen. Die Probe'),
    ],
    [
      'two spaces in a line',
      (text: string) => text.replace('spielen *zwei*', 'spielen  *zwei*'),
    ],
    [
      'spaces at the ends of lines',
      (text: string) => text.replaceAll('\n', ' \n'),
    ],
    ['line endings CR LF', (text: string) => text.replaceAll('\n', '\r\n')],
  ])('keeps a section its own after %s', (_name, edit) => {
    const { text, code } = own(report);
    const page = edit(`# Seite\n\nVon Hand.\n\n${text}`);
    expect(page).not.toBe(`# Seite\n\nVon Hand.\n\n${text}`);
    expect(judge(page, code).kind).toBe('own');
  });

  it.each([
    ['one word changed', (text: string) => text.replace('Sopran', 'Alt')],
    ['an item removed', (text: string) => text.replace('- Notenmappe\n', '')],
    [
      'a link added',
      (text: string) =>
        text.replace('Einsingen', '[Einsingen](https://example.org/)'),
    ],
    [
      'a bare address added',
      (text: string) =>
        text.replace('Einsingen', 'Einsingen https://example.org/'),
    ],
    [
      'bold taken away',
      (text: string) => text.replace('**Sonntag**', 'Sonntag'),
    ],
  ])('takes a section with %s for one a person changed', (_name, edit) => {
    const { text, code } = own(report);
    expect(judge(edit(text), code)).toEqual({ kind: 'changed' });
  });

  // The content policy writes no hard line break, so a section with one
  // has no canonical form: should the editor ever write one, the section
  // counts as changed (ADR 0032, remaining risks).
  it('takes a hard line break for a change', () => {
    const { text, code } = own(report);
    for (const hard of ['Gruppen.  \nDie', 'Gruppen.\\\nDie']) {
      expect(judge(text.replace('Gruppen.\nDie', hard), code)).toEqual({
        kind: 'changed',
      });
    }
  });

  // Without the key, nobody makes a code that fits (T10).
  it('takes a line with a code of another key or a made-up code for one a person changed', () => {
    const forged = own(report, interactive, otherKey);
    expect(judge(forged.text, forged.code)).toEqual({ kind: 'changed' });
    const { text, code } = own(report);
    const madeUp = text.replace(code, 'k1:ABCDEFGHIJKLM');
    expect(judge(madeUp, 'k1:ABCDEFGHIJKLM')).toEqual({ kind: 'changed' });
  });

  it('takes a section of another tenant, day or origin for one a person changed', () => {
    const { text } = own(report);
    for (const options of [
      { tenantId: 'demo-tenant', text },
      // The same line with another day says another origin.
      { tenantId, text: text.replace('05.11.2026', '06.11.2026') },
    ]) {
      expect(judgeSections({ key, ...options, matches: () => true })).toEqual({
        kind: 'changed',
      });
    }
    const ofRoutine = own(report, {
      kind: 'routine',
      routine: 'dienstplan-report',
      run: '2026-W40',
    });
    expect(
      judge(
        ofRoutine.text.replace(
          'Routine dienstplan-report, Lauf 2026-W40',
          'interaktiv',
        ),
        ofRoutine.code,
      ),
    ).toEqual({ kind: 'changed' });
  });

  it('says none when no line has the marking the write asks about', () => {
    const { text } = own(report);
    expect(judge(text, 'k1:ABCDEFGHIJKLM')).toEqual({ kind: 'none' });
    expect(judge('# Seite\n\nNur Text.\n')).toEqual({ kind: 'none' });
    expect(judge('')).toEqual({ kind: 'none' });
  });

  it('takes a line only as a paragraph of its own', () => {
    const { text, code } = own(report);
    const glued = text.replace('\n\nAutomatisch', '\nAutomatisch');
    expect(judge(glued, code)).toEqual({ kind: 'none' });
    const followed = text.replace(/\n$/u, '\nNoch eine Zeile.\n');
    expect(judge(followed, code)).toEqual({ kind: 'none' });
  });

  it('looks for the start of a section no further back than the line before it', () => {
    const first = own('## Erster Bericht\n\nText eins.');
    const second = own('## Zweiter Bericht\n\nText zwei.');
    const page = `${first.text}\n${second.text}`;
    expect(judge(page, second.code)).toEqual({
      kind: 'own',
      start: lineOf(page, '## Zweiter'),
      end: findMarkings(page)[1]?.line,
    });
    expect(judge(page, first.code)).toMatchObject({ kind: 'own', start: 0 });
    // A code over a section that holds the line before it: it would fit
    // from the start of the page, but the search stops at that line.
    const spanning = canonicalMarkdown(`${first.text}\nText zwei.`);
    if (spanning === undefined) throw new TypeError('No canonical form.');
    const code = checkCodeOf(key, tenantId, interactive, spanning);
    const line = markingLineOf(
      { date: day, origin: interactive, code },
      'Sekretariat',
    );
    expect(judge(`${first.text}\nText zwei.\n\n${line}\n`, code)).toEqual({
      kind: 'changed',
    });
  });

  it('takes the first own section of two with the same marking, also after a changed one', () => {
    const { text, code } = own(report);
    const changed = text.replace('Sopran', 'Alt');
    expect(judge(`${text}\n${text}`, code)).toMatchObject({
      kind: 'own',
      start: 0,
    });
    expect(judge(`${changed}\n${text}`, code)).toMatchObject({ kind: 'own' });
    expect(judge(`${changed}\n${changed}`, code)).toEqual({
      kind: 'changed',
    });
  });

  // The cap on the starts it tries: a section with more paragraphs than
  // that is not found, one just within is.
  it(`tries at most ${String(maxSectionStarts)} starts`, () => {
    const paragraphs = (count: number): string =>
      Array.from(
        { length: count },
        (_, index) => `Absatz ${String(index)}.`,
      ).join('\n\n');
    const within = own(paragraphs(maxSectionStarts));
    expect(judge(within.text, within.code)).toMatchObject({
      kind: 'own',
      start: 0,
    });
    const beyond = own(paragraphs(maxSectionStarts + 1));
    expect(judge(beyond.text, beyond.code)).toEqual({ kind: 'changed' });
  });
});

describe('findMarkings', () => {
  it('finds the lines of the marking in the order of the page', () => {
    const first = own('Eins.');
    const second = own('Zwei.');
    const page = `${first.text}\n${second.text}`;
    expect(findMarkings(page).map(({ marking }) => marking.code)).toEqual([
      first.code,
      second.code,
    ]);
    expect(findMarkings(page).map(({ line }) => line)).toEqual([2, 6]);
    expect(Object.isFrozen(findMarkings(page))).toBe(true);
  });

  it(`finds at most ${String(maxMarkings)} lines`, () => {
    const { text } = own('Eins.');
    const page = Array.from({ length: maxMarkings + 5 }, () => text).join('\n');
    expect(findMarkings(page)).toHaveLength(maxMarkings);
  });
});
