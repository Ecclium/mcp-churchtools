import {
  ahvOf,
  canaryFrom,
  groupedAhv,
  ibanOf,
  lookalikeOf,
  printedIban,
  searchable,
  variantOf,
} from '@ecclium/mcp-churchtools-testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { freeTextMarkers, maskFreeText } from './free-text.js';

// Property tests of the check of free text in the level strict (ADR 0069,
// ADR 0070). An e-mail address, a phone number, an IBAN or an AHV number
// anywhere in a text, in compatibility forms that NFKC folds back and with
// hidden characters inside, becomes its marker, and nothing of the value
// stays. A text without such a form, with dates and times, stays as it is.
//
// The check reads letters and digits of ASCII only. Digits of other
// scripts and letters that only look like Latin ones are not folded by
// NFKC, so it does not recognise a number written in them; the last block
// holds that limit. A fixed seed keeps the runs the same in CI.

const seed = 70_003;
const run = { seed, numRuns: 300 };

const choices = fc.array(fc.record({ form: fc.nat(8), hidden: fc.nat(20) }), {
  maxLength: 48,
});

// Words without digits and without @, so that nothing around a value can
// be read as part of it.
const words = fc
  .array(fc.stringMatching(/^[A-Za-zäöü]{1,10}$/), { maxLength: 5 })
  .map((list) => list.join(' '));

/** A value in the text and what of it must not stay. */
interface Planted {
  readonly kind: keyof typeof freeTextMarkers;
  readonly text: string;
  readonly cores: readonly string[];
}

const emails = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{10}$/),
    fc.stringMatching(/^[a-z0-9]{10}$/),
  )
  .map((cores): Planted => {
    const canary = canaryFrom('email', cores);
    return { kind: 'email', text: canary.value, cores: canary.cores };
  });

const phones = fc.stringMatching(/^[0-9]{12}$/).map((core): Planted => {
  const canary = canaryFrom('phone', [core]);
  return { kind: 'phone', text: canary.value, cores: canary.cores };
});

const ibans = fc
  .tuple(
    fc.constantFrom('CH', 'DE', 'AT', 'LI', 'GB'),
    fc.stringMatching(/^[0-9A-Z]{11,30}$/),
    fc.boolean(),
  )
  .map(([country, rest, printed]): Planted => {
    const iban = ibanOf(country, rest);
    return {
      kind: 'iban',
      text: printed ? printedIban(iban) : iban,
      cores: [rest],
    };
  });

const ahvs = fc
  .tuple(
    fc.stringMatching(/^[0-9]{9}$/),
    fc.constantFrom(undefined, '.', ' ', '-'),
  )
  .map(([nine, separator]): Planted => {
    const ahv = ahvOf(nine);
    return {
      kind: 'ahv',
      text: separator === undefined ? ahv : groupedAhv(ahv, separator),
      cores: [ahv.slice(3)],
    };
  });

const planted = fc.oneof(emails, phones, ibans, ahvs);

// A sentence with the value in it, in a variant, between words and in
// brackets or before a comma as a sentence has them.
const sentences = fc
  .record({
    value: planted,
    chosen: choices,
    before: words,
    after: words,
    opener: fc.constantFrom('', '(', '"'),
    closer: fc.constantFrom('', ',', '.', ')', '!'),
  })
  .map(({ value, chosen, before, after, opener, closer }) => ({
    value,
    text: `${before} ${opener}${variantOf(value.text, chosen)}${closer} ${after}`,
    // The words, the bracket and the sign after the value stay; the value
    // gives way to its marker as a whole.
    expected: `${before} ${opener}${freeTextMarkers[value.kind]}${closer} ${after}`,
  }));

describe('the check of free text', () => {
  it('puts its marker in place of every value, in any variant, and keeps nothing of it', () => {
    fc.assert(
      fc.property(sentences, ({ text, expected }) => {
        expect(maskFreeText(text)).toBe(expected);
      }),
      run,
    );
  });

  it('finds every value of a text with several of them', () => {
    fc.assert(
      fc.property(
        fc.array(planted, { minLength: 2, maxLength: 4 }),
        words,
        (values, filler) => {
          const masked = maskFreeText(
            values.map((value) => `${filler} ${value.text}`).join(', '),
          );
          // The words around them hold no digit, so no digit may stay,
          // not even a part of a number written with spaces.
          expect(masked.normalize('NFKC')).not.toMatch(/\p{Nd}/u);
          for (const value of values) {
            expect(masked).toContain(freeTextMarkers[value.kind]);
            for (const core of value.cores) {
              expect(searchable(masked)).not.toContain(core.toLowerCase());
            }
          }
        },
      ),
      run,
    );
  });

  it('leaves a text with words, dates and times as it is', () => {
    const dates = fc
      .record({
        year: fc.integer({ min: 1900, max: 2099 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
      })
      .chain(({ year, month, day, hour, minute }) => {
        const two = (value: number): string => String(value).padStart(2, '0');
        const time = `${two(hour)}.${two(minute)}`;
        return fc.constantFrom(
          `${two(day)}.${two(month)}.${String(year)}`,
          `${String(year)}-${two(month)}-${two(day)}`,
          `${two(day)}.${two(month)}.`,
          time,
          `${time}-${two((hour + 1) % 24)}.${two(minute)}`,
        );
      });
    // A word stands between two of them. Several dates and times in one
    // run of digits, such as 05.03. 2026-01-02 2027-01-01, can read as a
    // phone number, which hides too much, never too little.
    const word = fc.stringMatching(/^[A-Za-zäöü]{1,10}$/);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(word, dates), { maxLength: 6 }),
        words,
        (parts, end) => {
          const text = `${parts.map(([before, date]) => `${before} ${date}`).join(' ')} ${end}`;
          expect(maskFreeText(text)).toBe(text);
        },
      ),
      run,
    );
  });
});

describe('the limit of the check of free text', () => {
  // NFKC folds none of these characters, so the check does not read them
  // as digits or as Latin letters. A field with a class is masked all the
  // same; only free text keeps such a number (ADR 0069).
  const all = (text: string): number[] =>
    Array.from({ length: text.length }, () => 1);

  it('does not recognise a phone number, an IBAN or an AHV number in digits of other scripts', () => {
    fc.assert(
      fc.property(fc.oneof(phones, ibans, ahvs), (value) => {
        const foreign = lookalikeOf(value.text, all(value.text));
        const text = `Kontakt ${foreign} heute`;
        expect(maskFreeText(text)).toBe(text);
      }),
      { seed, numRuns: 50 },
    );
  });

  // The check reads numbers in the forms they are printed in: an IBAN in
  // one run or in groups of four with one space, an AHV number in one run
  // or with the same dot, space or hyphen between its groups, a phone
  // number from +, ( or 0. A number in another form stays (ADR 0069),
  // unless a part of it that starts with 0 reads as a phone number, which
  // these digits avoid: no group starts with 0.
  const noZeroLead = (groups: readonly number[]): RegExp =>
    new RegExp(
      `^${groups.map((size) => `[1-9][0-9]{${String(size - 1)}}`).join('')}$`,
      'u',
    );
  it('does not recognise numbers in other printed forms', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.constantFrom('CH', 'DE', 'AT'),
            fc.stringMatching(noZeroLead([4, 4, 4, 4, 1])),
          )
          .map(([country, rest]) => ibanOf(country, rest))
          .filter((value) => value.charAt(2) !== '0'),
        fc.stringMatching(noZeroLead([4, 4, 1])),
        fc.stringMatching(noZeroLead([2, 3, 2, 2])),
        (iban, nine, local) => {
          const printed = printedIban(iban);
          const ahv = ahvOf(nine);
          for (const text of [
            printed.replaceAll(' ', '-'),
            printed.replaceAll(' ', '  '),
            `${ahv.slice(0, 3)}.${ahv.slice(3, 7)} ${ahv.slice(7, 11)}.${ahv.slice(11)}`,
            `${ahv.slice(0, 3)}/${ahv.slice(3, 7)}/${ahv.slice(7, 11)}/${ahv.slice(11)}`,
            `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7)}`,
          ]) {
            expect(maskFreeText(`Kontakt ${text} heute`)).toBe(
              `Kontakt ${text} heute`,
            );
          }
        },
      ),
      { seed, numRuns: 50 },
    );
  });

  it('still recognises an e-mail address in letters of other scripts', () => {
    fc.assert(
      fc.property(emails, (value) => {
        const foreign = lookalikeOf(value.text, all(value.text));
        expect(maskFreeText(`Kontakt ${foreign} heute`)).toBe(
          `Kontakt ${freeTextMarkers.email} heute`,
        );
      }),
      { seed, numRuns: 50 },
    );
  });
});
