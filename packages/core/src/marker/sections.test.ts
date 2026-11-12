import { isIsoDate, type IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { canonicalMarkdown, checkMarkdown } from '../content/index.js';
import { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, type MarkingOrigin, sameCheckCode } from './code.js';
import { type Marking, markingLineOf } from './line.js';
import {
  canonicalSectionOf,
  findMarkings,
  judgeSections,
  maxJudgedMarkings,
  markingsAskedFor,
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

  // A remaining risk (ADR 0032): a list at the end of the text before and
  // one of the same kind at the start of the section read as one list.
  it('takes a section that starts with a list after a list of the same kind for none of its own', () => {
    const { text, code } = own('- Eins\n- Zwei');
    expect(judge(`- Vorher\n\n${text}`, code).kind).not.toBe('own');
    expect(judge(`1. Vorher\n\n${text}`, code)).toMatchObject({ kind: 'own' });
  });

  // A section a reader cannot see is not Ecclium's own: inside a comment
  // or a block of code its line is no line of the marking, so the write
  // adds the section again where readers see it (T10).
  it('finds no own section inside a comment or a block of code', () => {
    const { text, code } = own(report);
    const lookAlike = text.replace('Sopran', 'Alt');
    for (const page of [
      `# Seite\n\n<!--\n\n${text}\n-->\n\n${lookAlike}`,
      `# Seite\n\n\`\`\`\n${text}\`\`\`\n\n${lookAlike}`,
      `# Seite\n\n~~~\n${text}~~~\n`,
    ]) {
      expect(judge(page, code).kind, page).not.toBe('own');
    }
  });

  // HTML that is no closed comment could hide what follows, such as an
  // open details element, which the core cannot tell: such a page counts
  // as changed when a line matches.
  it('takes a page with HTML that could hide a section for one a person changed', () => {
    const { text, code } = own(report);
    for (const page of [
      `<details>\n\n${text}\n</details>\n`,
      `<div hidden>\n\n${text}`,
      `Text mit <span hidden>HTML</span>.\n\n${text}`,
    ]) {
      expect(judge(page, code), page).toEqual({ kind: 'changed' });
    }
    expect(judge(`<!-- Ein Kommentar -->\n\n${text}`, code)).toMatchObject({
      kind: 'own',
    });
    // Without a line the write asks about, the page has none.
    expect(judge(`<details>\n\n${text}`, 'k1:ABCDEFGHIJKLM')).toEqual({
      kind: 'none',
    });
  });

  // Ecclium writes none of them, so a hidden sign or one NFKC changes
  // means a person changed what a reader sees, such as a mark that turns
  // the direction of a number.
  it('takes a hidden sign or a sign NFKC changes for a change, but not a protected space', () => {
    const { text, code } = own(report);
    const turn = String.fromCodePoint(0x202e);
    const pop = String.fromCodePoint(0x202c);
    for (const edit of [
      text.replace('Sopran | 4', `Sopran | ${turn}4${pop}`),
      text.replace('18 Uhr', `1${String.fromCodePoint(0x200b)}8 Uhr`),
      text.replace('Bass | 2', `Bass | ${String.fromCodePoint(0xb2)}`),
    ]) {
      expect(judge(edit, code), edit).toEqual({ kind: 'changed' });
    }
    expect(
      judge(text.replace('um 18', `um${String.fromCodePoint(0xa0)}18`), code),
    ).toMatchObject({ kind: 'own' });
  });

  it(`judges at most ${String(maxJudgedMarkings)} lines that match, and then takes the page for changed`, () => {
    const { text, code } = own(report);
    const line = text
      .split('\n')
      .find((entry) => entry.startsWith('Automatisch'));
    const copies = (count: number): string =>
      Array.from(
        { length: count },
        (_, index) => `Kopie ${String(index)}.\n\n${String(line)}\n`,
      ).join('\n');
    expect(
      judge(`${copies(maxJudgedMarkings - 1)}\n${text}`, code),
    ).toMatchObject({
      kind: 'own',
    });
    expect(judge(`${copies(maxJudgedMarkings)}\n${text}`, code)).toEqual({
      kind: 'changed',
    });
  });

  it('takes a page it cannot read for changed when a line matches, else for none', () => {
    const { text, code } = own(report);
    const heavy = `${'*'.repeat(2001)}\n\n`;
    expect(judge(`${heavy}${text}`, code)).toEqual({ kind: 'changed' });
    expect(judge(`${heavy}Nur Text.\n`, code)).toEqual({ kind: 'none' });
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

  it('finds no line inside a comment or a block of code, and none on a page it cannot read', () => {
    const { text } = own('Eins.');
    expect(findMarkings(`<!--\n\n${text}\n-->\n`)).toEqual([]);
    expect(findMarkings(`\`\`\`\n${text}\`\`\`\n`)).toEqual([]);
    expect(findMarkings(`${'*'.repeat(2001)}\n\n${text}`)).toEqual([]);
  });
});

describe('markingsAskedFor and canonicalSectionOf', () => {
  const first = own('Eins.');
  const second = own('## Zwei\n\n- Probe\n- Pause\n');
  const page = `# Plan\n\n${first.text}\n${second.text}`;
  const asked = (code: string) => (marking: Marking) =>
    sameCheckCode(marking.code, code);

  it('finds the lines a write asks about, each with the line after the marking before', () => {
    expect(
      markingsAskedFor({ text: page, matches: asked(second.code) }),
    ).toEqual({
      kind: 'read',
      hides: false,
      lines: [
        {
          marking: expect.objectContaining({ code: second.code }) as unknown,
          line: page.split('\n').length - 2,
          earliest: lineOf(page, 'Automatisch') + 1,
        },
      ],
    });
    expect(
      markingsAskedFor({ text: page, matches: asked(first.code) }),
    ).toMatchObject({ lines: [{ earliest: 0 }] });
    expect(
      markingsAskedFor({ text: `<details>\n\n${page}`, matches: () => true }),
    ).toMatchObject({ kind: 'read', hides: true });
    expect(
      markingsAskedFor({ text: `${page}\r`, matches: () => true }),
    ).toEqual({ kind: 'unreadable' });
  });

  it('gives the canonical form of the section between a first line and a line of the marking', () => {
    const lines = page.split('\n');
    const end = lines.length - 2;
    const start = lineOf(page, '## Zwei');
    expect(canonicalSectionOf(page, start, end)).toBe(
      canonicalMarkdown('## Zwei\n\n- Probe\n- Pause\n'),
    );
    // The page cannot be read, no line of the marking at the end, no block
    // at the start, or no block between.
    expect(canonicalSectionOf(`${page}\r`, start, end)).toBeUndefined();
    expect(canonicalSectionOf(page, start, end - 1)).toBeUndefined();
    expect(canonicalSectionOf(page, start - 1, end)).toBeUndefined();
    expect(canonicalSectionOf(page, start + 3, end)).toBeUndefined();
    expect(canonicalSectionOf(page, end, end)).toBeUndefined();
    // A block outside the allowed part has no canonical form.
    const linked = `Mehr: [Plan](https://example.org/)\n\n${second.text}`;
    expect(
      canonicalSectionOf(linked, 0, linked.split('\n').length - 2),
    ).toBeUndefined();
  });
});
