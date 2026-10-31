import {
  canaryFrom,
  hiddenCharacters,
  lookalikeOf,
  searchable,
  variantOf,
} from '@ecclium/mcp-churchtools-testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  maskBirthdate,
  maskedValue,
  maskEmail,
  maskLastName,
  maskPhone,
  visiblePhoneDigits,
} from './mask.js';
import {
  cleanText,
  hiddenCharactersNote,
  removeHiddenCharacters,
} from './unicode.js';

// Property tests of the masks of classified fields (ADR 0026, ADR 0070).
// A field with the class email, phone, birthdate or name.last is masked
// whatever its characters are: in compatibility forms, with hidden
// characters and in look-alikes of other scripts. Either the mask reads
// the value or the whole value becomes the marker; no other text goes out.
// A fixed seed keeps the runs the same in CI.

const seed = 70_002;

const choices = fc.array(fc.record({ form: fc.nat(8), hidden: fc.nat(20) }), {
  maxLength: 48,
});
const looks = fc.array(fc.nat(3), { maxLength: 48 });

// The value itself, a variant that NFKC folds back, one in look-alikes,
// and one that mixes both.
const variantsOf = (value: string): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant(value),
    choices.map((chosen) => variantOf(value, chosen)),
    looks.map((chosen) => lookalikeOf(value, chosen)),
    fc
      .tuple(looks, choices)
      .map(([look, chosen]) => variantOf(lookalikeOf(value, look), chosen)),
  );

const emails = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{10}$/),
    fc.stringMatching(/^[a-z0-9]{10}$/),
  )
  .map((cores) => canaryFrom('email', cores));
const phones = fc
  .stringMatching(/^[0-9]{12}$/)
  .map((core) => canaryFrom('phone', [core]));
const lastNames = fc.stringMatching(/^[A-Z][a-z]{10}[äöüé]$/);

// Digits of any script after NFKC, so that a look-alike number that went
// out unmasked counts as well.
const digitsOf = (text: string): number =>
  (text.normalize('NFKC').match(/\p{Nd}/gu) ?? []).length;

const run = { seed, numRuns: 300 };

describe('the mask of an e-mail address', () => {
  it('lets no part of the address through, in any variant', () => {
    fc.assert(
      fc.property(
        emails.chain((canary) =>
          fc.tuple(fc.constant(canary), variantsOf(canary.value)),
        ),
        ([canary, text]) => {
          const masked = maskEmail(text);
          expect(
            masked === maskedValue ||
              /^[a-z0-9*]\*{3}@example\.org$/u.test(masked),
            masked,
          ).toBe(true);
          for (const core of canary.cores) {
            expect(searchable(masked)).not.toContain(core);
          }
        },
      ),
      run,
    );
  });

  it('keeps the first sign and the domain of a plain address', () => {
    fc.assert(
      fc.property(emails, (canary) => {
        expect(maskEmail(canary.value)).toBe(
          `${canary.value.charAt(0)}***@example.org`,
        );
      }),
      run,
    );
  });
});

describe('the mask of a phone number', () => {
  it('shows at most four digits and no part of the number, in any variant', () => {
    fc.assert(
      fc.property(
        phones.chain((canary) =>
          fc.tuple(fc.constant(canary), variantsOf(canary.value)),
        ),
        ([canary, text]) => {
          const masked = maskPhone(text);
          expect(digitsOf(masked)).toBeLessThanOrEqual(visiblePhoneDigits);
          expect(searchable(masked).replaceAll(' ', '')).not.toContain(
            canary.cores[0],
          );
          if (masked !== maskedValue) {
            expect(masked).toHaveLength(canary.value.length);
          }
        },
      ),
      run,
    );
  });
});

describe('the mask of a date of birth', () => {
  const dates = fc
    .record({
      year: fc.integer({ min: 1900, max: 2025 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      swiss: fc.boolean(),
    })
    .map(({ year, month, day, swiss }) => {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return {
        year: String(year),
        text: swiss
          ? `${dd}.${mm}.${String(year)}`
          : `${String(year)}-${mm}-${dd}`,
      };
    });

  it('gives only the year or the marker, in any variant', () => {
    fc.assert(
      fc.property(
        dates.chain((date) =>
          fc.tuple(fc.constant(date), variantsOf(date.text)),
        ),
        ([date, text]) => {
          const masked = maskBirthdate(text);
          expect([date.year, maskedValue]).toContain(masked);
          if (text === date.text) expect(masked).toBe(date.year);
        },
      ),
      run,
    );
  });
});

describe('the shortened last name of strict', () => {
  it('gives one sign and a dot or the marker, in any variant', () => {
    fc.assert(
      fc.property(lastNames.chain(variantsOf), (text) => {
        const masked = maskLastName(text);
        if (masked === maskedValue) return;
        const first = String.fromCodePoint(masked.codePointAt(0) ?? 0);
        expect(masked).toBe(`${first}.`);
        expect(searchable(first)).toBe(searchable(text).charAt(0));
      }),
      run,
    );
  });
});

describe('the removal of hidden characters', () => {
  it('turns every variant of printable ASCII back into its value after NFKC', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme-ascii', maxLength: 40 }),
        choices,
        (value, chosen) => {
          const variant = variantOf(value, chosen).normalize('NFKC');
          expect(removeHiddenCharacters(variant).text).toBe(value);
        },
      ),
      run,
    );
  });

  it('leaves no hidden character, notes what it removed and changes a cleaned text no more', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 40 }),
        choices,
        (value, chosen) => {
          const cleaned = cleanText(variantOf(value, chosen));
          for (const hidden of hiddenCharacters) {
            expect(cleaned).not.toContain(hidden);
          }
          expect(cleanText(cleaned)).toBe(cleaned);
          const removed = removeHiddenCharacters(variantOf(value, chosen));
          if (removed.removed > 0) {
            expect(
              cleaned.endsWith(hiddenCharactersNote(removed.removed)),
            ).toBe(true);
          }
        },
      ),
      run,
    );
  });
});
