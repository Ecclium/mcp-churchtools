import { isIsoDate, type IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { canonicalMarkdown, checkMarkdown } from '../content/index.js';
import { KeyMaterial } from '../keys/index.js';
import {
  checkCodeOf,
  judgeSections,
  type Marking,
  markingLineOf,
  type MarkingOrigin,
} from '../marker/index.js';
import { planAdoption, type WrittenPage } from './adopt.js';
import { appendSection, replaceSection } from './guard.js';
import { contentHashOf } from './plan-hash.js';

// The adoption of a section of a run after the key of the check codes was
// lost (ADR 0032), from pages built as a run writes them. All data are made
// up.

const lostKey = new KeyMaterial('0123456789abcdef'.repeat(4));
const key = new KeyMaterial('fedcba9876543210'.repeat(4));
const tenantId = 'default';
const routine = 'dienstplan-report';
const period = '2026-W46';
const origin: MarkingOrigin = { kind: 'routine', routine, run: period };

const dayOf = (value: string): IsoDate => {
  if (!isIsoDate(value)) throw new TypeError('No day.');
  return value;
};
const day = dayOf('2026-11-09');

// A section as a run writes it: the written form of the content policy,
// an empty line and the line of the marking, signed with a key.
const sectionOf = (
  section: string,
  signWith = lostKey,
  of: MarkingOrigin = origin,
): string => {
  const written = checkMarkdown(section, { contacts: new Set() });
  if (!written.ok) throw new TypeError('The section does not pass.');
  const canonical = canonicalMarkdown(written.text);
  if (canonical === undefined) throw new TypeError('No canonical form.');
  const code = checkCodeOf(signWith, tenantId, of, canonical);
  const line = markingLineOf({ date: day, origin: of, code }, 'Sekretariat');
  return `${written.text}\n${line}`;
};

// A write of a run that appends a section, and what its snapshot keeps.
const append = (
  before: string,
  section: string,
): { readonly text: string; readonly written: WrittenPage } => {
  const text = appendSection(before, section);
  return { text, written: { before, afterHash: contentHashOf([text]) } };
};

// What a snapshot of a write that left a text would keep.
const left = (before: string, text: string): WrittenPage => ({
  before,
  afterHash: contentHashOf([text]),
});

const report = sectionOf('## Dienste KW 46\n\n- Sonntag: Mesmer fehlt\n');
// As ChurchTools stores it, without a line break at the end (F51).
const head = '# Dienstplan-Auswertung\n\nWas die Routine findet.';

const plan = (text: string, written: readonly WrittenPage[]) =>
  planAdoption({ key, tenantId, text, routine, period, written });

const matches = (marking: Marking): boolean =>
  marking.origin.kind === 'routine' &&
  marking.origin.routine === routine &&
  marking.origin.run === period;

const codeless = (line: string): string => line.replace(/k1:[A-Z2-7]{13}/u, '');

describe('planAdoption', () => {
  it('signs a section the snapshot of its write proves anew, changing only the code of its line', () => {
    const { text, written } = append(head, report);
    const found = plan(text, [written]);
    expect(found.kind).toBe('proven');
    if (found.kind !== 'proven') return;
    const lines = text.split('\n');
    const end = lines.length - 1;
    expect(found).toMatchObject({
      proof: 0,
      start: 4,
      end,
      oldLine: lines[end],
    });
    expect(found.section).toBe(lines.slice(4, end).join('\n'));
    expect(found.section.startsWith('## Dienste KW 46')).toBe(true);
    // Only the code changes.
    expect(found.newLine).not.toBe(found.oldLine);
    expect(codeless(found.newLine)).toBe(codeless(found.oldLine));
    expect(found.text).toBe([...lines.slice(0, end), found.newLine].join('\n'));
    // The page with the new line holds Ecclium's own section for the key
    // of today, the old one did not.
    expect(judgeSections({ key, tenantId, text, matches }).kind).toBe(
      'changed',
    );
    expect(judgeSections({ key, tenantId, text: found.text, matches })).toEqual(
      { kind: 'own', start: 4, end },
    );
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('proves a section a run wrote on an empty page, which begins at the first line', () => {
    const { text, written } = append('', report);
    expect(plan(text, [written])).toMatchObject({ kind: 'proven', start: 0 });
  });

  it('keeps what stands after the line and its spaces at the end, and takes the first write that proves', () => {
    const first = append(head, report);
    // A person added a paragraph below the line since the write.
    const text = `${first.text}\n\nNachtrag einer Person.`;
    const other = append('# Anders', report).written;
    const found = plan(text, [other, first.written]);
    expect(found).toMatchObject({ kind: 'proven', proof: 1 });
    if (found.kind !== 'proven') return;
    expect(found.text.endsWith('\n\nNachtrag einer Person.')).toBe(true);
    expect(found.newLine.endsWith('Rückfragen an Sekretariat.')).toBe(true);
    // Spaces at the end of the line do not count for reading and stay.
    const spaced = `${first.text}  `;
    const kept = plan(spaced, [left(head, spaced)]);
    expect(kept.kind === 'proven' && kept.newLine.endsWith('.  ')).toBe(true);
  });

  it('finds nothing to do for a section whose code fits, and no line on a page without one', () => {
    const { text, written } = append(head, sectionOf('## KW 46\n', key));
    expect(plan(text, [written])).toEqual({ kind: 'own' });
    expect(plan(head, [written])).toEqual({ kind: 'none' });
    // A line of another period is none of this period.
    const otherPeriod = append(
      head,
      sectionOf('## KW 45\n', lostKey, { ...origin, run: '2026-W45' }),
    );
    expect(plan(otherPeriod.text, [otherPeriod.written])).toEqual({
      kind: 'none',
    });
  });

  it('proves nothing without a snapshot, after a change of a person and after the page changed above', () => {
    const { text, written } = append(head, report);
    expect(plan(text, [])).toEqual({ kind: 'unproven', range: text });
    // A person changed a word of the section.
    const changed = text.replace('Mesmer fehlt', 'Mesmer gefunden');
    expect(plan(changed, [written])).toMatchObject({ kind: 'unproven' });
    // A person changed the text above the section.
    const above = text.replace('Was die Routine findet.', 'Was sie findet.');
    expect(plan(above, [written])).toMatchObject({ kind: 'unproven' });
  });

  it('shows the range from the line of the marking before', () => {
    const earlier = append(
      head,
      sectionOf('## KW 45\n', key, { ...origin, run: '2026-W45' }),
    );
    const { text } = append(earlier.text, report);
    const found = plan(text, []);
    expect(found.kind).toBe('unproven');
    if (found.kind !== 'unproven') return;
    expect(found.range.startsWith('\n## Dienste KW 46')).toBe(true);
    expect(found.range).not.toContain('KW 45');
  });

  it('proves no section a later run of the period replaced, since its start was known only to the old key', () => {
    const first = append(head, report);
    const second = sectionOf('## Dienste KW 46\n\n- Sonntag: besetzt\n');
    const replaced = replaceSection(
      first.text,
      { start: 4, end: first.text.split('\n').length - 1 },
      second,
    );
    expect(
      plan(replaced, [left(first.text, replaced), first.written]),
    ).toMatchObject({ kind: 'unproven' });
  });

  it('cannot tell with two lines of the period, HTML that could hide a section, or a page the lexer cannot read', () => {
    const { text, written } = append(head, report);
    const twice = append(text, report);
    expect(plan(twice.text, [twice.written])).toEqual({
      kind: 'unclear',
      reason: 'several',
    });
    expect(plan(`<details>\n\n${text}`, [written])).toEqual({
      kind: 'unclear',
      reason: 'hidden',
    });
    expect(plan(`${text}\r`, [written])).toEqual({
      kind: 'unclear',
      reason: 'unreadable',
    });
  });

  it('signs no line outside the fixed form and no section without a canonical form', () => {
    const { text } = append(head, report);
    const lines = text.split('\n');
    // The reader takes the line in the normal form NFC; the core never
    // writes one in another form, so it does not sign it.
    const decomposed = text.replace('Prüfcode', 'Prüfcode');
    expect(plan(decomposed, [left(head, decomposed)])).toMatchObject({
      kind: 'unsignable',
    });
    // A link a person put in has no canonical form.
    const linked = appendSection(
      head,
      `## KW 46\n\nMehr: [Plan](https://example.org/)\n\n${lines.at(-1) ?? ''}`,
    );
    expect(plan(linked, [left(head, linked)])).toMatchObject({
      kind: 'unsignable',
    });
  });

  it('signs no section the page would not judge as its own, such as one that begins before the line of another marking', () => {
    // A text after that holds a line of another period inside what the
    // write appended, which the content policy never lets through.
    const inner = sectionOf('## KW 45\n', key, { ...origin, run: '2026-W45' });
    const text = appendSection(head, `## KW 46\n\n${inner}\n\n${report}`);
    expect(plan(text, [left(head, text)])).toMatchObject({
      kind: 'unsignable',
    });
  });
});
