import { describe, expect, it } from 'vitest';

import {
  datedConfirmationTextOf,
  confirmationField,
  confirmationForm,
  confirmationLimits,
  confirmationMessage,
  type ConfirmationPreview,
  confirmationTextOf,
  isConfirmed,
  maxSummaryTitleLength,
  visibleText,
} from './confirmation-text.js';

const preview = (
  change: Partial<ConfirmationPreview>,
): ConfirmationPreview => ({
  kind: 'wikiSectionAppend',
  categoryId: 12,
  title: 'Plan',
  before: '# Plan\n',
  after: '# Plan\n\n## Nachtrag\n',
  ...change,
});

// n lines "line 1" to "line n", each with its line break.
const linesOf = (count: number, word = 'line'): string =>
  Array.from(
    { length: count },
    (_, index) => `${word} ${String(index)}\n`,
  ).join('');

describe('visible text', () => {
  it('keeps letters, umlauts, quotes and the tab', () => {
    expect(visibleText('Grüsse «aus» Bern\tund 1 + 1')).toBe(
      'Grüsse «aus» Bern\tund 1 + 1',
    );
  });

  it('doubles a backslash, so that a text cannot write the visible form itself', () => {
    expect(visibleText('\\u{202e}')).toBe('\\\\u{202e}');
  });

  it.each([
    ['an escape', '\u001b[31m', '\\u{1b}[31m'],
    ['a null', '\u0000', '\\u{0}'],
    ['a line feed', 'a\nb', 'a\\u{a}b'],
    ['a carriage return', 'a\rb', 'a\\u{d}b'],
    ['DEL', '\u007f', '\\u{7f}'],
    ['a control of C1', '\u0085', '\\u{85}'],
    ['a soft hyphen', 'Sil­be', 'Sil\\u{ad}be'],
    ['a mark of the writing direction', 'a‮b', 'a\\u{202e}b'],
    ['an isolate of the writing direction', '⁦x⁩', '\\u{2066}x\\u{2069}'],
    ['the Arabic letter mark', '؜', '\\u{61c}'],
    ['a space of zero width', 'a​b', 'a\\u{200b}b'],
    ['the word joiner', 'a⁠b', 'a\\u{2060}b'],
    ['a byte order mark', '﻿a', '\\u{feff}a'],
    ['a separator of lines', 'a b', 'a\\u{2028}b'],
    ['a filler of Hangul', 'ㅤ', '\\u{3164}'],
    ['a variation selector', 'a️', 'a\\u{fe0f}'],
    ['a tag character', 'a\u{e0041}', 'a\\u{e0041}'],
    ['a lone surrogate', 'a\ud800b', 'a\\u{d800}b'],
  ])('shows %s as its code point', (_name, text, shown) => {
    expect(visibleText(text)).toBe(shown);
  });

  it('keeps a pair of surrogates that stands for a character', () => {
    expect(visibleText('Ja 👍')).toBe('Ja 👍');
  });
});

describe('the text of a confirmation', () => {
  it('says what an appended section does, with the diff of the page', () => {
    const text = confirmationTextOf(preview({}));
    expect(text.summary).toBe(
      'An die Seite «Plan» in der Kategorie 12 einen Abschnitt mit 2 Zeilen anhängen.',
    );
    expect(text.diff).toEqual([
      '@@ -1,1 +1,3 @@',
      ' # Plan',
      '+',
      '+## Nachtrag',
    ]);
    expect(text.fits).toBe(true);
    expect(Object.isFrozen(text)).toBe(true);
    expect(Object.isFrozen(text.diff)).toBe(true);
  });

  it('says what a change does, with the lines it adds and removes', () => {
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageUpdate',
        before: 'a\nb\n',
        after: 'a\nc\nd\n',
      }),
    );
    expect(text.summary).toBe(
      'Die Seite «Plan» in der Kategorie 12 ändern: 2 Zeilen neu, 1 Zeile weg.',
    );
  });

  it('says what a new page does, with its title as planned', () => {
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageCreate',
        title: 'Neu',
        before: '',
        after: '# Neu\n',
      }),
    );
    expect(text.summary).toBe(
      'Neue Seite «Neu» in der Kategorie 12 mit 1 Zeile anlegen.',
    );
    expect(text.diff).toEqual(['@@ -0,0 +1,1 @@', '+# Neu']);
  });

  it('makes every hidden character of the title and the diff visible', () => {
    const text = confirmationTextOf(
      preview({
        title: 'Pl‮an',
        before: 'a\n',
        after: 'a\n\u001b[2J​\n',
      }),
    );
    expect(text.summary).toContain('«Pl\\u{202e}an»');
    expect(text.diff).toContain('+\\u{1b}[2J\\u{200b}');
  });

  it('cuts a long title after its code points, before it makes it visible', () => {
    const long = `${'ä'.repeat(maxSummaryTitleLength)}‮`;
    const text = confirmationTextOf(preview({ title: long }));
    expect(text.summary).toContain(
      `«${'ä'.repeat(maxSummaryTitleLength - 1)}…»`,
    );
    expect(text.summary).not.toContain('202e');
    const exact = 'b'.repeat(maxSummaryTitleLength);
    expect(confirmationTextOf(preview({ title: exact })).summary).toContain(
      `«${exact}»`,
    );
  });

  it('shows the whole title of a new page, since it is written whole, and counts it', () => {
    const long = `${'T'.repeat(200)}‮${'e'.repeat(54)}`;
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageCreate',
        title: long,
        before: '',
        after: 'x\n',
      }),
    );
    expect(text.summary).toContain(
      `«${'T'.repeat(maxSummaryTitleLength - 1)}…»`,
    );
    expect(text.title).toBe(`${'T'.repeat(200)}\\u{202e}${'e'.repeat(54)}`);
    expect(confirmationMessage(text).split('\n')).toContain(
      `Titel der neuen Seite: «${text.title ?? ''}»`,
    );
    // A change keeps its title in the summary only.
    expect(confirmationTextOf(preview({})).title).toBeUndefined();
    // The title counts against the limit of characters: the header of 16
    // and the line of 11'972 leave room for 12 more.
    const wide = 'x'.repeat(11_970);
    expect(
      confirmationTextOf(
        preview({
          kind: 'wikiPageCreate',
          title: 'kurz',
          before: '',
          after: `${wide}\n`,
        }),
      ).fits,
    ).toBe(true);
    expect(
      confirmationTextOf(
        preview({
          kind: 'wikiPageCreate',
          title: 't'.repeat(20),
          before: '',
          after: `${wide}\n`,
        }),
      ).fits,
    ).toBe(false);
  });

  it('shows the quotes of a title as code points, so that it cannot close the quote of the sentence', () => {
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageCreate',
        title: 'Plan» in der Kategorie 5 mit 1 Zeile anlegen. «Plan ‹›',
        before: '',
        after: 'x\n',
      }),
    );
    expect(text.summary).toBe(
      'Neue Seite «Plan\\u{bb} in der Kategorie 5 mit 1 Zeile anlegen. \\u{ab}Plan \\u{2039}\\u{203a}» in der Kategorie 12 mit 1 Zeile anlegen.',
    );
    expect(text.title).toContain('\\u{bb}');
  });

  it('keeps the marks of the diff, and shows a combining mark at the start of a line', () => {
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageUpdate',
        before: '̶alt\n',
        after: 'neu\\',
      }),
    );
    expect(text.diff).toEqual([
      '@@ -1,1 +1,1 @@',
      '-\\u{336}alt',
      '+neu\\\\',
      '\\ No newline at end of file',
    ]);
    // A combining mark later in a line joins the text before it, which is
    // the page's own.
    expect(
      confirmationTextOf(
        preview({ kind: 'wikiPageUpdate', before: '', after: 'a̶\n' }),
      ).diff,
    ).toEqual(['@@ -0,0 +1,1 @@', '+a̶']);
  });

  it('keeps an empty line of the page as its sign alone', () => {
    const text = confirmationTextOf(
      preview({ kind: 'wikiPageUpdate', before: '', after: '\n' }),
    );
    expect(text.diff).toEqual(['@@ -0,0 +1,1 @@', '+']);
  });

  it('fits up to 120 changed lines and 12000 characters, and no more', () => {
    expect(confirmationLimits).toEqual({
      changedLines: 120,
      characters: 12_000,
    });
    const at = confirmationTextOf(
      preview({ kind: 'wikiPageUpdate', before: '', after: linesOf(120) }),
    );
    expect(at.fits).toBe(true);
    const over = confirmationTextOf(
      preview({ kind: 'wikiPageUpdate', before: '', after: linesOf(121) }),
    );
    expect(over.fits).toBe(false);
    // Few lines, but long ones.
    const wide = confirmationTextOf(
      preview({
        kind: 'wikiPageUpdate',
        before: '',
        after: `${'x'.repeat(6_000)}\n${'y'.repeat(6_000)}\n`,
      }),
    );
    expect(wide.fits).toBe(false);
    const narrow = confirmationTextOf(
      preview({
        kind: 'wikiPageUpdate',
        before: '',
        after: `${'x'.repeat(5_000)}\n${'y'.repeat(5_000)}\n`,
      }),
    );
    expect(narrow.fits).toBe(true);
  });

  it('counts the characters as shown, so that hidden characters weigh more', () => {
    // 2'000 hidden characters take 8 or more characters each once shown.
    const text = confirmationTextOf(
      preview({
        kind: 'wikiPageUpdate',
        before: '',
        after: `${'​'.repeat(2_000)}\n`,
      }),
    );
    expect(text.fits).toBe(false);
  });
});

// The confirmation of an appointment or a booking (ADR 0072): names of
// ChurchTools made visible, the public calendar and the mail of a booking
// request named (F48).
describe('the text of a confirmation of an appointment or a booking', () => {
  const span = 'Sonntag, 08.11.2026, 09:00 bis 10:00 (UTC)';

  it('names a new appointment, its calendar and that the calendar is public', () => {
    const text = datedConfirmationTextOf({
      kind: 'appointmentCreate',
      place: { id: 8, name: 'Gottesdienste' },
      title: 'Probe',
      span,
      before: '',
      after: 'Titel: Probe\nBeginn: a\nEnde: b\n',
      changed: [],
      isPublic: true,
    });
    expect(text.summary).toBe(
      `Einen Termin «Probe» im Kalender «Gottesdienste» anlegen: ${span}. Der Kalender ist öffentlich: Den Termin sieht auch, wer nicht angemeldet ist.`,
    );
    expect(text.diff).toEqual([
      '@@ -0,0 +1,3 @@',
      '+Titel: Probe',
      '+Beginn: a',
      '+Ende: b',
    ]);
    expect(text.fits).toBe(true);
    expect(Object.isFrozen(text)).toBe(true);
  });

  it('names the fields a change changes, in German', () => {
    const text = (changed: readonly string[]) =>
      datedConfirmationTextOf({
        kind: 'appointmentUpdate',
        place: { id: 8 },
        title: 'Gottesdienst',
        span,
        before: 'Titel: A\n',
        after: 'Titel: B\n',
        changed,
        isPublic: false,
      }).summary;
    expect(text(['Titel'])).toBe(
      `Beim Termin «Gottesdienst» im Kalender 8 Titel ändern, danach ${span}.`,
    );
    expect(text(['Titel', 'Beginn', 'Ende'])).toContain(
      'Titel, Beginn und Ende ändern',
    );
  });

  it('says that a booking request goes to the managers by mail and counts other bookings', () => {
    const text = (overlapping?: number) =>
      datedConfirmationTextOf({
        kind: 'bookingCreate',
        place: { id: 13 },
        title: 'Probe',
        span,
        before: '',
        after: 'Titel: Probe\n',
        changed: [],
        ...(overlapping === undefined ? {} : { overlapping }),
      }).summary;
    expect(text()).toBe(
      `Eine Buchung der Ressource 13 anfragen: «Probe», ${span}. ChurchTools schickt Titel und Beschreibung per Mail an die Verwalter der Ressource.`,
    );
    expect(text(1)).toContain(
      'Zur selben Zeit hat die Ressource eine weitere Buchung.',
    );
    expect(text(3)).toContain(
      'Zur selben Zeit hat die Ressource 3 weitere Buchungen.',
    );
  });

  it('makes names and fields of ChurchTools visible', () => {
    const text = datedConfirmationTextOf({
      kind: 'appointmentCreate',
      place: { id: 8, name: 'Kalender»\u202e' },
      title: 'Pro\u200bbe',
      span,
      before: '',
      after: 'Titel: Pro\u200bbe\n',
      changed: [],
    });
    expect(text.summary).toContain('«Pro\\u{200b}be»');
    expect(text.summary).toContain('«Kalender\\u{bb}\\u{202e}»');
    expect(text.diff).toContain('+Titel: Pro\\u{200b}be');
  });
});

describe('the message and the form of a question', () => {
  it('names what Ecclium would write, the diff and how to confirm', () => {
    const text = confirmationTextOf(preview({}));
    const message = confirmationMessage(text);
    expect(message.split('\n')).toEqual([
      'Ecclium möchte in ChurchTools schreiben.',
      '',
      text.summary,
      '',
      ...text.diff,
      '',
      'Wählen Sie «Ja», damit Ecclium genau diese Änderung schreibt. Ohne Bestätigung schreibt Ecclium nichts.',
    ]);
  });

  it('has one field, yes or no, made anew for every question', () => {
    const form = confirmationForm();
    expect(form).toEqual({
      type: 'object',
      properties: {
        bestaetigen: {
          type: 'boolean',
          title: 'Schreiben bestätigen',
          description: 'Ja, wenn Ecclium diese Änderung schreiben soll.',
        },
      },
      required: ['bestaetigen'],
    });
    expect(confirmationForm()).not.toBe(form);
    expect(confirmationField).toBe('bestaetigen');
  });

  it('confirms only with the one field set to yes', () => {
    expect(isConfirmed({ bestaetigen: true })).toBe(true);
    for (const content of [
      { bestaetigen: false },
      { bestaetigen: 'ja' },
      { bestaetigen: 1 },
      { bestaetigen: true, farbe: 'blau' },
      {},
      [],
      null,
      undefined,
      'true',
    ]) {
      expect(isConfirmed(content)).toBe(false);
    }
  });
});
