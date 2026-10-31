import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canaryFrom } from './canary.js';
import { ahvOf, groupedAhv, ibanOf, printedIban } from './synthetic-numbers.js';
import {
  compatibilityForms,
  hiddenCharacters,
  lookalikeOf,
  lookalikes,
  searchable,
  variantOf,
} from './variants.js';

// The variants are only worth something if they keep their promise: a
// compatibility form folds back under NFKC, a look-alike does not, and a
// hidden character is neither folded nor visible. A fixed seed keeps the
// runs the same in CI (ADR 0070).
const seed = 70_001;

const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) =>
  String.fromCharCode(0x20 + index),
);

const choice = fc.record({ form: fc.nat(8), hidden: fc.nat(20) });

describe('the compatibility forms', () => {
  it('fold back to their character under NFKC, for every printable character of ASCII', () => {
    for (const character of printable) {
      const forms = compatibilityForms(character);
      expect(forms.length, character).toBeGreaterThan(0);
      for (const form of forms) {
        expect(form, character).not.toBe(character);
        expect(form.normalize('NFKC'), character).toBe(character);
      }
    }
  });

  it('give digits four forms and letters two', () => {
    expect(compatibilityForms('7')).toHaveLength(4);
    expect(compatibilityForms('k')).toHaveLength(2);
    expect(compatibilityForms('@')).toHaveLength(2);
  });

  it('do not exist outside printable ASCII or for more than one character', () => {
    expect(compatibilityForms('ä')).toEqual([]);
    expect(compatibilityForms('\n')).toEqual([]);
    expect(compatibilityForms('ab')).toEqual([]);
    expect(compatibilityForms('')).toEqual([]);
  });
});

describe('the look-alikes', () => {
  it('stay different under NFKC', () => {
    for (const character of printable) {
      for (const lookalike of lookalikes(character)) {
        expect(lookalike.normalize('NFKC'), character).not.toBe(character);
      }
    }
    expect(lookalikes('5')).toHaveLength(2);
    expect(lookalikes('a')).toHaveLength(1);
    expect(lookalikes('b')).toEqual([]);
    expect(lookalikes('ab')).toEqual([]);
    expect(lookalikes('')).toEqual([]);
  });

  it('change a value where a character has one', () => {
    expect(lookalikeOf('a1b', [1, 2, 1])).not.toBe('a1b');
    expect(lookalikeOf('a1b', [])).toBe('a1b');
    expect(lookalikeOf('b', [3])).toBe('b');
  });
});

describe('the hidden characters', () => {
  it('stay as they are under NFKC and are no printable ASCII', () => {
    expect(hiddenCharacters.length).toBeGreaterThan(10);
    for (const hidden of hiddenCharacters) {
      expect(hidden.normalize('NFKC')).toBe(hidden);
      expect(printable).not.toContain(hidden);
    }
  });
});

describe('a variant', () => {
  it('is the value again after NFKC and without the hidden characters', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme-ascii', maxLength: 40 }),
        fc.array(choice, { maxLength: 40 }),
        (value, choices) => {
          const variant = variantOf(value, choices);
          expect(searchable(variant)).toBe(value.toLowerCase());
        },
      ),
      { seed, numRuns: 200 },
    );
  });

  it('keeps a value without choices, and a character without forms', () => {
    expect(variantOf('max', [])).toBe('max');
    expect(variantOf('ä', [{ form: 3, hidden: 0 }])).toBe('ä');
    expect(variantOf('a', [{ form: 0, hidden: 1 }])).toBe(
      `${hiddenCharacters[0] ?? ''}a`,
    );
  });
});

describe('the synthetic numbers', () => {
  // The check of ISO 7064 written another way: the whole number, the first
  // four characters moved to the end, leaves 1 when divided by 97.
  const ibanValid = (iban: string): boolean => {
    const moved = iban.slice(4) + iban.slice(0, 4);
    let digits = '';
    for (const character of moved) {
      const code = character.charCodeAt(0);
      digits += code >= 0x41 ? String(code - 0x41 + 10) : character;
    }
    return BigInt(digits) % 97n === 1n;
  };

  // EAN-13 written another way: all thirteen digits, weighted 1 and 3 in
  // turn, add up to a multiple of ten.
  const ahvValid = (ahv: string): boolean => {
    let sum = 0;
    for (let index = 0; index < ahv.length; index += 1) {
      sum += Number(ahv.charAt(index)) * (index % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  };

  it('carry a valid check sum and check digit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('CH', 'DE', 'AT', 'LI', 'GB'),
        fc.stringMatching(/^[0-9A-Z]{11,30}$/),
        fc.stringMatching(/^[0-9]{9}$/),
        (country, rest, nine) => {
          const iban = ibanOf(country, rest);
          expect(ibanValid(iban)).toBe(true);
          expect(iban).toHaveLength(rest.length + 4);
          expect(printedIban(iban).replaceAll(' ', '')).toBe(iban);
          const ahv = ahvOf(nine);
          expect(ahv).toMatch(/^756[0-9]{10}$/);
          expect(ahvValid(ahv)).toBe(true);
          expect(groupedAhv(ahv, '.').replaceAll('.', '')).toBe(ahv);
        },
      ),
      { seed, numRuns: 200 },
    );
  });

  it('print in groups', () => {
    const iban = ibanOf('CH', '00000000000000012');
    expect(
      printedIban(iban)
        .split(' ')
        .map((group) => group.length),
    ).toEqual([4, 4, 4, 4, 4, 1]);
    expect(groupedAhv(ahvOf('000000001'), '-').split('-')).toHaveLength(4);
  });
});

describe('a canary from given parts', () => {
  it('has the shapes of the random canaries', () => {
    const email = canaryFrom('email', ['k3x9a2b7q1', 'm8n4p0r6t5']);
    expect(email.value).toBe('k3x9a2b7q1.m8n4p0r6t5@example.org');
    expect(email.minFragment).toBe(8);
    const name = canaryFrom('name', ['Abcdefghijkl', 'Mnopqrstuvwä']);
    expect(name.value).toBe('Abcdefghijkl Mnopqrstuvwä');
    expect(name.minFragment).toBe(12);
    const phone = canaryFrom('phone', ['123456789012']);
    expect(phone.value.replaceAll(' ', '')).toBe('+410123456789012');
    expect(canaryFrom('email', ['abc', 'defghijkl']).minFragment).toBe(3);
  });
});
