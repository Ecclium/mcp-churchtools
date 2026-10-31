import { describe, expect, it } from 'vitest';

import {
  ahvCheckDigitFits,
  freeTextMarkers,
  ibanCheckSumFits,
  maskFreeText,
  maxIbanLength,
  minIbanLength,
} from './free-text.js';

const { email, phone, iban, ahv } = freeTextMarkers;

const u = (codePoint: number): string => String.fromCodePoint(codePoint);

// Every number of these tests is made here from synthetic digits with its
// check sum or check digit, so that no real IBAN or AHV number stands in
// the repository.

// An IBAN of a country with the given letters and digits after the check
// digits, which this computes after ISO 7064.
const ibanOf = (country: string, rest: string): string => {
  let remainder = 0;
  for (const character of `${rest}${country}00`) {
    const code = character.charCodeAt(0);
    const value = code >= 0x41 ? code - 0x41 + 10 : code - 0x30;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return `${country}${String(98 - remainder).padStart(2, '0')}${rest}`;
};

// The printed form: groups of four with one space.
const printed = (value: string): string =>
  value.replace(/(.{4})(?=.)/gu, '$1 ');

// An AHV number from nine synthetic digits after 756, with the check
// digit of EAN-13.
const ahvOf = (nine: string): string => {
  const twelve = `756${nine}`;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(twelve.charAt(index)) * (index % 2 === 0 ? 1 : 3);
  }
  return `${twelve}${String((10 - (sum % 10)) % 10)}`;
};

const dotted = (value: string): string =>
  `${value.slice(0, 3)}.${value.slice(3, 7)}.${value.slice(7, 11)}.${value.slice(11)}`;

// A digit changed, so that the check fails.
const typo = (value: string, at: number): string =>
  value.slice(0, at) +
  String((Number(value.charAt(at)) + 1) % 10) +
  value.slice(at + 1);

const swiss = ibanOf('CH', '00000000000000012');
const german = ibanOf('DE', '000000000000000034');
const austrian = ibanOf('AT', '0000000000000056');
const british = ibanOf('GB', 'ABCD00000000000078');
const person = ahvOf('000000001');

describe('the numbers of these tests', () => {
  it('carry valid checks and the lengths of their countries', () => {
    for (const value of [swiss, german, austrian, british]) {
      expect(ibanCheckSumFits(value), value).toBe(true);
    }
    expect([swiss, german, austrian].map((value) => value.length)).toEqual([
      21, 22, 20,
    ]);
    expect(ahvCheckDigitFits(person)).toBe(true);
    expect(ahvCheckDigitFits(typo(person, 12))).toBe(false);
    expect(ibanCheckSumFits(typo(swiss, 10))).toBe(false);
  });
});

describe('maskFreeText', () => {
  it('masks an e-mail address in a sentence, without what encloses it', () => {
    expect(maskFreeText('Kontakt: max.mustermann@example.org.')).toBe(
      `Kontakt: ${email}.`,
    );
    expect(maskFreeText('(<max.mustermann@example.org>)')).toBe(`(<${email}>)`);
    expect(maskFreeText('mailto:max.mustermann@example.org')).toBe(email);
    expect(maskFreeText('max@bücher.example')).toBe(email);
    expect(maskFreeText('@max.mustermann@example.org')).toBe(email);
    expect(maskFreeText('Mail (@max@example.org)')).toBe(`Mail (${email})`);
  });

  it('leaves an @ that is no address', () => {
    for (const text of [
      '@team',
      'a@b',
      'a@.org',
      'x@y.c',
      'Treffpunkt@19.30',
      '«»@',
    ]) {
      expect(maskFreeText(text), text).toBe(text);
    }
  });

  it('masks a phone number from +, ( or 0', () => {
    expect(maskFreeText('Tel. 000 000 12 34, danke')).toBe(
      `Tel. ${phone}, danke`,
    );
    expect(maskFreeText('+41 00 000 12 34')).toBe(phone);
    expect(maskFreeText('(000) 000-12-34')).toBe(phone);
    expect(maskFreeText('Fax:0000001234')).toBe(`Fax:${phone}`);
    // A run of short groups is a phone number when it has a group of three
    // or is written with spaces only.
    expect(maskFreeText('000.000.12.34')).toBe(phone);
    expect(maskFreeText('00 00 12 34 56')).toBe(phone);
    expect(maskFreeText('+41-00-12-34-56')).toBe(phone);
    // Three separators between two digits, as in a number with a slash or
    // a dash between spaces.
    expect(maskFreeText('Tel. 000 / 000 12 34')).toBe(`Tel. ${phone}`);
    expect(maskFreeText('000 - 000 12 34')).toBe(phone);
  });

  it('leaves dates, times and numbers that do not start like a phone number', () => {
    for (const text of [
      'am 01.10.2026 um 19:30',
      'am01.10.2026',
      '(01.10.2026)',
      '(2026-10-01)',
      'Freizeit 01.-03.10.2026',
      'Sa, 05.03. 19.30 Uhr',
      'Zeit 09.30-10.30 Uhr',
      'am 07.11.2026-09.11.2026',
      'CCLI 1234567',
      'Postfach 1234',
      '000 12',
      'Raum 3000000',
    ]) {
      expect(maskFreeText(text), text).toBe(text);
    }
  });

  it('masks an IBAN stored or printed, in either case', () => {
    expect(maskFreeText(`IBAN ${swiss}, Kollekte`)).toBe(
      `IBAN ${iban}, Kollekte`,
    );
    expect(maskFreeText(`IBAN ${printed(swiss)} Mitglieder`)).toBe(
      `IBAN ${iban} Mitglieder`,
    );
    expect(maskFreeText(printed(german))).toBe(iban);
    expect(maskFreeText(swiss.toLowerCase())).toBe(iban);
    expect(maskFreeText(printed(british))).toBe(iban);
  });

  it('ends a printed IBAN where its check sum fits, before a word of four', () => {
    expect(maskFreeText(`${printed(austrian)} Wien`)).toBe(`${iban} Wien`);
    expect(maskFreeText(`${printed(austrian)} 1234 5678`)).toBe(
      `${iban} 1234 5678`,
    );
  });

  it('leaves what looks like an IBAN without its check sum', () => {
    for (const text of [
      typo(swiss, 10),
      printed(typo(german, 12)),
      `${swiss}X`,
      `X${swiss}`,
      'CH12 3456',
      'CH12',
      'AB12 ,',
      'AB12 CDEFG',
      `CH${'1'.repeat(minIbanLength - 3)}`,
      `CH${'1'.repeat(maxIbanLength - 1)}`,
      printed(`CH12${'0'.repeat(maxIbanLength)}`),
    ]) {
      expect(maskFreeText(text).includes(iban), text).toBe(false);
    }
  });

  it('masks an AHV number in one run, with dots or with spaces', () => {
    expect(maskFreeText(`AHV ${person}.`)).toBe(`AHV ${ahv}.`);
    expect(maskFreeText(`AHV-Nr. ${dotted(person)}`)).toBe(`AHV-Nr. ${ahv}`);
    expect(maskFreeText(`(${dotted(person)})`)).toBe(`(${ahv})`);
    expect(maskFreeText(dotted(person).replaceAll('.', ' '))).toBe(ahv);
    expect(maskFreeText(dotted(person).replaceAll('.', '-'))).toBe(ahv);
  });

  it('leaves what looks like an AHV number without its check digit', () => {
    for (const text of [
      typo(person, 12),
      dotted(typo(person, 5)),
      `${person}0`,
      `1${person}`,
      `${dotted(person).slice(0, 8)} ${dotted(person).slice(9)}`,
      dotted(person).slice(0, 12),
      '756',
    ]) {
      expect(maskFreeText(text).includes(ahv), text).toBe(false);
    }
  });

  it('finds forms of full width and numbers with hidden characters', () => {
    const fullWidth = (text: string): string =>
      Array.from({ length: text.length }, (_, index) => {
        const code = text.charCodeAt(index);
        return code >= 0x30 && code <= 0x39
          ? u(code - 0x30 + 0xff10)
          : text.charAt(index);
      }).join('');
    expect(maskFreeText(fullWidth('000 000 12 34'))).toBe(phone);
    expect(maskFreeText(`max${u(0xff20)}example.org`)).toBe(email);
    expect(
      maskFreeText(`${swiss.slice(0, 6)}${u(0x200b)}${swiss.slice(6)}`),
    ).toBe(iban);
    expect(maskFreeText(fullWidth(person))).toBe(ahv);
  });

  it('masks several finds in one text, each with its marker', () => {
    expect(
      maskFreeText(
        `Max: max.mustermann@example.org, +41 00 000 12 34, ${printed(swiss)}, ${dotted(person)}`,
      ),
    ).toBe(`Max: ${email}, ${phone}, ${iban}, ${ahv}`);
  });

  it('gives a text without a find back as it was, and one with a find normalised', () => {
    const ligature = `Au${u(0xfb00)}ahrt am Sonntag`;
    expect(maskFreeText(ligature)).toBe(ligature);
    expect(maskFreeText(`${ligature}, 000 000 12 34`)).toBe(
      `Auffahrt am Sonntag, ${phone}`,
    );
    expect(maskFreeText('')).toBe('');
  });

  it('leaves its own markers as they are', () => {
    const marked = maskFreeText(
      `max.mustermann@example.org ${swiss} ${person} 000 000 12 34`,
    );
    expect(maskFreeText(marked)).toBe(marked);
  });
});

describe('ahvCheckDigitFits', () => {
  it('takes exactly thirteen digits', () => {
    expect(ahvCheckDigitFits(person.slice(0, 12))).toBe(false);
    expect(ahvCheckDigitFits(`${person.slice(0, 12)}x`)).toBe(false);
  });
});
