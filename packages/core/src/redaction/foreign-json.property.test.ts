import {
  canaryFrom,
  searchable,
  variantOf,
} from '@ecclium/mcp-churchtools-testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { renderForeignJson } from './foreign-json.js';

// Property tests of the mask by form of the escape hatch (ADR 0067, ADR
// 0070). Its answers have no schema, so the mask reads the names of the
// fields and the form of each text. An e-mail address or a phone number in
// any text of an answer, at any depth, also in compatibility forms and
// with hidden characters, is masked, a value under a field for a secret
// goes as a whole, and under a field for a date of birth only the year
// stays. In off the values stay, which shows that the test sees them. A
// fixed seed keeps the runs the same in CI.

const seed = 70_005;
const run = { seed, numRuns: 200 };

// The text as the search reads it, also without spaces, since a phone
// number is written with spaces between its digits.
const squeezed = (text: string): string => searchable(text).replaceAll(' ', '');

const choices = fc.array(fc.record({ form: fc.nat(8), hidden: fc.nat(20) }), {
  maxLength: 48,
});

/** A value of an answer and the parts that must not go out. */
interface Gen {
  readonly value: unknown;
  readonly cores: readonly string[];
}

const words = fc
  .array(fc.stringMatching(/^[A-Za-z]{1,10}$/), { maxLength: 4 })
  .map((list) => list.join(' '));

// A text with an e-mail address or a phone number in it, in a variant.
const planted: fc.Arbitrary<Gen> = fc
  .record({
    canary: fc.oneof(
      fc
        .tuple(
          fc.stringMatching(/^[a-z0-9]{10}$/),
          fc.stringMatching(/^[a-z0-9]{10}$/),
        )
        .map((cores) => canaryFrom('email', cores)),
      fc
        .stringMatching(/^[0-9]{12}$/)
        .map((core) => canaryFrom('phone', [core])),
    ),
    chosen: choices,
    before: words,
    after: words,
  })
  .map(({ canary, chosen, before, after }) => ({
    value: `${before} ${variantOf(canary.value, chosen)} ${after}`,
    cores: canary.cores,
  }));

// A secret under a field whose name asks for the whole value to go.
const secrets: fc.Arbitrary<{ readonly key: string } & Gen> = fc
  .tuple(
    fc.constantFrom('apiToken', 'password', 'clientSecret', 'randomUrl'),
    fc.stringMatching(/^[A-Za-z0-9]{16}$/),
  )
  .map(([key, value]) => ({ key, value, cores: [value] }));

// Names without a mask of their own.
const keys = fc
  .stringMatching(/^[a-z]{1,8}$/)
  .filter(
    (key) =>
      !key.endsWith('mail') &&
      !key.includes('phone') &&
      !key.includes('token') &&
      !key.includes('secret'),
  );

const plain: fc.Arbitrary<Gen> = fc
  .oneof(
    fc.stringMatching(/^[A-Za-z ]{0,12}$/),
    fc.integer({ min: 0, max: 10_000 }),
    fc.boolean(),
    fc.constant(null),
  )
  .map((value) => ({ value, cores: [] }));

// An answer of objects and lists with plain values, planted texts and
// secrets under their fields at any depth.
const answers = fc.letrec<{ readonly tree: Gen }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', maxDepth: 4 },
    plain,
    planted,
    fc.array(tie('tree'), { maxLength: 4 }).map((items) => ({
      value: items.map((item) => item.value),
      cores: items.flatMap((item) => item.cores),
    })),
    fc
      .uniqueArray(
        fc.oneof(
          fc.tuple(keys, tie('tree')),
          secrets.map((secret): [string, Gen] => [secret.key, secret]),
        ),
        { maxLength: 4, selector: ([key]) => key },
      )
      .map((entries) => ({
        value: Object.fromEntries(
          entries.map(([key, item]) => [key, item.value]),
        ),
        cores: entries.flatMap(([, item]) => item.cores),
      })),
  ),
})).tree;

describe('the mask by form of the escape hatch', () => {
  it('lets no address, number or secret of an answer through, at any depth', () => {
    fc.assert(
      fc.property(answers, (answer) => {
        const rendered = renderForeignJson(answer.value, 'standard');
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) return;
        expect(() => JSON.parse(rendered.text) as unknown).not.toThrow();
        for (const core of answer.cores) {
          expect(squeezed(rendered.text)).not.toContain(core.toLowerCase());
        }
      }),
      run,
    );
  });

  it('keeps every value in off', () => {
    fc.assert(
      fc.property(answers, (answer) => {
        const rendered = renderForeignJson(answer.value, 'off');
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) return;
        for (const core of answer.cores) {
          expect(squeezed(rendered.text)).toContain(core.toLowerCase());
        }
      }),
      run,
    );
  });

  it('keeps only the year of a date of birth', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'birthday',
          'dateOfBirth',
          'geburtsdatum',
          'motherBirthdate',
        ),
        fc.integer({ min: 1900, max: 2025 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (key, year, month, day) => {
          const date = `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const rendered = renderForeignJson(
            { data: [{ id: 1, [key]: date }] },
            'standard',
          );
          expect(rendered).toEqual({
            ok: true,
            text: `{"data":[{"id":1,"${key}":"${String(year)}"}]}`,
          });
        },
      ),
      run,
    );
  });

  it('masks an address or a number that stands in the name of a field', () => {
    fc.assert(
      fc.property(planted, (key) => {
        const rendered = renderForeignJson(
          { [key.value as string]: 1 },
          'standard',
        );
        if (!rendered.ok) return;
        for (const core of key.cores) {
          expect(squeezed(rendered.text)).not.toContain(core.toLowerCase());
        }
      }),
      run,
    );
  });
});
