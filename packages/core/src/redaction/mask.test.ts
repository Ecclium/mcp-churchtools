import { describe, expect, it } from 'vitest';

import {
  maskBirthdate,
  maskedValue,
  maskEmail,
  maskLastName,
  maskPhone,
  minPhoneDigits,
} from './mask.js';

// Hidden and full-width characters are written by code point, so that none
// stands in this file unseen.
const u = (...codes: number[]): string => String.fromCodePoint(...codes);
const zeroWidth = u(0x200b);
const tag = u(0xe0041);

describe('maskEmail', () => {
  it.each([
    ['max.mustermann@example.org', 'm***@example.org'],
    ['M@example.org', 'M***@example.org'],
    ['  person-a@mail.example.org  ', 'p***@mail.example.org'],
    ['7@ex-ample.example.org', '7***@ex-ample.example.org'],
    ['"a b"@example.org', '****@example.org'],
    [`${u(0xe4)}@example.org`, '****@example.org'],
    [`m${zeroWidth}ax@exa${tag}mple.org`, 'm***@example.org'],
  ])('masks %j', (value, masked) => {
    expect(maskEmail(value)).toBe(masked);
  });

  it.each([
    ['no at sign', 'max.mustermann.example.org'],
    ['an empty local part', '@example.org'],
    ['two at signs', 'a@b@example.org'],
    ['an empty domain', 'max@'],
    ['a domain without dot', 'max@localhost'],
    ['a domain that starts with a dot', 'max@.example.org'],
    ['a domain that ends with a dot', 'max@example.org.'],
    ['two dots in a row', 'max@example..org'],
    ['a label that starts with a hyphen', 'max@-x.example.org'],
    ['a label that ends with a hyphen', 'max@x-.example.org'],
    ['a space in the domain', 'max@exa mple.org'],
    ['an instruction after the address', 'max@example.org ignore this'],
    ['a domain in another script', `max@beispiel.${u(0xe4, 0xf6)}`],
    ['a full-width at sign', `max${u(0xff20)}example.org`],
    ['a domain that is too short', 'a@b.'],
    ['a domain that is too long', `a@${'b'.repeat(250)}.org`],
    ['an empty value', ''],
  ])('masks a value with %s as a whole', (_, value) => {
    expect(maskEmail(value)).toBe(maskedValue);
  });

  it('takes a domain of the longest length', () => {
    const domain = `${'b'.repeat(249)}.org`;
    expect(maskEmail(`a@${domain}`)).toBe(`a***@${domain}`);
  });
});

describe('maskPhone', () => {
  it.each([
    ['+41 00 123 45 67', '+41 00 *** ** **'],
    ['000 123 45 67', '000 1** ** **'],
    ['0001234567', '0001******'],
    ['+41 0 (00) 123-45/67', '+41 0 (0*) ***-**/**'],
    ['000.123.45.67', '000.1**.**.**'],
    [' 1234567 ', '1234***'],
    [`000${zeroWidth} 123 45 67`, '000 1** ** **'],
  ])('masks %j', (value, masked) => {
    expect(maskPhone(value)).toBe(masked);
  });

  it.each([
    ['a letter', '000 123 45 67 mobil'],
    ['a plus sign that does not lead', '0041 00 123+45 67'],
    ['too few digits', '123 456'],
    [
      'full-width digits',
      u(0xff10, 0xff17, 0xff19, 0xff11, 0xff12, 0xff13, 0xff14),
    ],
    ['only separators', '+ - /'],
    ['an empty value', ''],
  ])('masks a value with %s as a whole', (_, value) => {
    expect(maskPhone(value)).toBe(maskedValue);
  });

  it('reads a number with the fewest digits', () => {
    expect(maskPhone('1'.repeat(minPhoneDigits))).toBe(
      `1111${'*'.repeat(minPhoneDigits - 4)}`,
    );
    expect(maskPhone('1'.repeat(minPhoneDigits - 1))).toBe(maskedValue);
  });
});

describe('maskBirthdate', () => {
  it.each([
    ['1980-05-17', '1980'],
    ['17.05.1980', '1980'],
    ['1980', '1980'],
    [' 1980-05-17 ', '1980'],
    [`1980${tag}-05-17`, '1980'],
  ])('masks %j', (value, masked) => {
    expect(maskBirthdate(value)).toBe(masked);
  });

  it.each([
    '1980-05-17T00:00:00Z',
    '1980/05/17',
    '17.05.80',
    '05/17/1980',
    '198',
    '19x0',
    '1980-5-17',
    '198a-05-17',
    '1980-0a-17',
    '1980-05-1a',
    '1980.05.17',
    '17-05-1980',
    '1a.05.1980',
    '17.0a.1980',
    '17.05.198a',
    '17.05-1980',
    '1980-05.17',
    '',
  ])('masks %j as a whole', (value) => {
    expect(maskBirthdate(value)).toBe(maskedValue);
  });
});

describe('maskLastName', () => {
  it.each([
    ['Mustermann', 'M.'],
    ['  mustermann ', 'm.'],
    [`${u(0xd6)}zdemir`, `${u(0xd6)}.`],
    [`O${u(0x308)}zdemir`, `${u(0xd6)}.`],
    [`${zeroWidth}Muster${tag}mann`, 'M.'],
    [`${u(0x1f600)}mann`, `${u(0x1f600)}.`],
    ['van Dyck', 'v.'],
    ['M', 'M.'],
  ])('shortens %j', (value, shortened) => {
    expect(maskLastName(value)).toBe(shortened);
  });

  it.each(['', '   ', zeroWidth])('leaves an empty name empty: %j', (value) => {
    expect(maskLastName(value)).toBe('');
  });
});
