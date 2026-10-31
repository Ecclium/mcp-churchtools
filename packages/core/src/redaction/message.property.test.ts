import {
  canaryFrom,
  searchable,
  variantOf,
} from '@ecclium/mcp-churchtools-testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { maxMessageLength } from '../errors/index.js';
import { visiblePhoneDigits } from './mask.js';
import { maskErrorDescription, maskMessage } from './message.js';

// Property tests of the mask of messages of failed calls (ADR 0054, ADR
// 0070). A message has no data class, so the mask reads the form: an
// e-mail address, a phone number or a date anywhere in it, also in
// compatibility forms and with hidden characters, is masked, and nothing
// of the value stays but the first sign of an address, its domain, four
// digits of a number and the year of a date. A fixed seed keeps the runs
// the same in CI.

const seed = 70_004;
const run = { seed, numRuns: 300 };

const choices = fc.array(fc.record({ form: fc.nat(8), hidden: fc.nat(20) }), {
  maxLength: 48,
});

// Words of a message, without digits and without @.
const words = fc
  .array(fc.stringMatching(/^[A-Za-z]{1,10}$/), { maxLength: 5 })
  .map((list) => list.join(' '));

const emails = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{10}$/),
    fc.stringMatching(/^[a-z0-9]{10}$/),
  )
  .map((cores) => canaryFrom('email', cores));
const phones = fc
  .stringMatching(/^[0-9]{12}$/)
  .map((core) => canaryFrom('phone', [core]));

const digitsOf = (text: string): number => {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) count += 1;
  }
  return count;
};

describe('the mask of messages', () => {
  it('keeps nothing of an e-mail address but its first sign and domain, in any variant', () => {
    fc.assert(
      fc.property(
        emails,
        choices,
        words,
        words,
        (email, chosen, before, after) => {
          const masked = maskMessage(
            `${before} <${variantOf(email.value, chosen)}>. ${after}`,
          );
          for (const core of email.cores) {
            expect(searchable(masked)).not.toContain(core);
          }
        },
      ),
      run,
    );
  });

  it('shows at most four digits of a phone number, in any variant', () => {
    fc.assert(
      fc.property(
        phones,
        choices,
        words,
        words,
        (phone, chosen, before, after) => {
          const masked = maskMessage(
            `${before} ${variantOf(phone.value, chosen)}, ${after}`,
          );
          expect(searchable(masked).replaceAll(' ', '')).not.toContain(
            phone.cores[0],
          );
          expect(digitsOf(masked.normalize('NFKC'))).toBeLessThanOrEqual(
            visiblePhoneDigits,
          );
        },
      ),
      run,
    );
  });

  it('keeps only the year of a date, in any variant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.constantFrom('.', '/', '-'),
        fc.boolean(),
        choices,
        words,
        (year, month, day, separator, yearFirst, chosen, before) => {
          const parts = [
            String(day).padStart(2, '0'),
            String(month).padStart(2, '0'),
          ];
          const date = yearFirst
            ? [String(year), parts[1], parts[0]].join(separator)
            : [...parts, String(year)].join(separator);
          const masked = maskMessage(`${before} ${variantOf(date, chosen)}`);
          expect(masked).toBe(`${before} ${String(year)}`);
        },
      ),
      run,
    );
  });
});

describe('the mask of the description of an error', () => {
  // A message as an EccliumError carries it: one line of printable ASCII.
  const messages = fc
    .record({
      email: emails,
      phone: phones,
      before: words,
      after: words,
    })
    .map(({ email, phone, before, after }) => ({
      text: `${before} ${email.value} ${after} ${phone.value}`,
      cores: [...email.cores, ...phone.cores],
    }));

  it('masks in every level but off and never grows beyond the longest message', () => {
    fc.assert(
      fc.property(
        messages,
        fc.constantFrom('standard', 'strict', 'other'),
        (message, level) => {
          const description = Object.freeze({
            code: 'upstream' as const,
            message: message.text,
          });
          const masked = maskErrorDescription(description, level as 'standard');
          expect(masked.code).toBe('upstream');
          expect(masked.message.length).toBeLessThanOrEqual(maxMessageLength);
          for (const core of message.cores) {
            expect(
              searchable(masked.message).replaceAll(' ', ''),
            ).not.toContain(core);
          }
          expect(maskErrorDescription(description, 'off')).toBe(description);
        },
      ),
      run,
    );
  });
});
