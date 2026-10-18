import { describe, expect, it } from 'vitest';

import {
  describeError,
  type ErrorDescription,
  fixedSentences,
  maxMessageLength,
} from '../errors/index.js';
import { maskErrorDescription, maskMessage } from './message.js';

const u = (...codes: number[]): string => String.fromCodePoint(...codes);
// The full-width form of an ASCII text, as NFKC folds it back.
const fullWidth = (text: string): string => {
  let wide = '';
  for (let index = 0; index < text.length; index += 1) {
    wide += u(text.charCodeAt(index) - 0x20 + 0xff00);
  }
  return wide;
};

describe('maskMessage', () => {
  it.each([
    [
      'an address',
      'No access for max.mustermann@example.org.',
      'No access for m***@example.org.',
    ],
    [
      'an address in brackets',
      'Person A (<max.mustermann@example.org>) exists',
      'Person A (<m***@example.org>) exists',
    ],
    [
      'two addresses and a word with an at sign',
      'a@example.org, b@example.org and c@d',
      'a***@example.org, b***@example.org and [masked]',
    ],
    [
      'an international phone number',
      'Call +41 00 123 45 67 now',
      'Call +41 00 *** ** ** now',
    ],
    [
      'a national phone number at the end',
      'Number: 000 123 45 67',
      'Number: 000 1** ** **',
    ],
    [
      'a number with hyphens, slashes and dots',
      'Fax 000-123/45.67.',
      'Fax 000-1**/**.**.',
    ],
    [
      'a run of seven digits',
      'Reference 1234567 is gone',
      'Reference 1234*** is gone',
    ],
    ['a run of eight digits', 'Digits 12345678', 'Digits 1234****'],
    ['an ISO date', 'Born on 1980-05-17.', 'Born on 1980.'],
    ['a Swiss date', 'Geboren am 17.05.1980', 'Geboren am 1980'],
    [
      'a date with a time',
      'At 1980-05-17T10:00 it failed',
      'At 1980T10:00 it failed',
    ],
    [
      'dates that go on as numbers',
      'Then 1980-05-170 and 17.05.19800',
      'Then 1980-**-*** and 17.05.*****',
    ],
    [
      'an address with digits',
      'Mail 1234567@example.org now',
      'Mail 1***@example.org now',
    ],
  ])('masks %s', (_, text, masked) => {
    expect(maskMessage(text)).toBe(masked);
  });

  it.each([
    'The input is not valid.',
    'Narrow the search to at most 50 results of 64 KiB.',
    'Page 123456 of 2 at 12:30',
    'Two separators 123  4567 or a trailing one 123456-',
    'A plus without digits + or with few +123',
    'Version 3.137.0 and 2026-1-5',
  ])('leaves %j as it is', (text) => {
    expect(maskMessage(text)).toBe(text);
  });

  it('finds contact data written in full width or with hidden characters', () => {
    expect(maskMessage(`Mail max${u(0xff20)}example.org`)).toBe(
      'Mail m***@example.org',
    );
    expect(maskMessage(`Call ${fullWidth('0001234567')}`)).toBe(
      'Call 0001******',
    );
    expect(maskMessage(`Born ${fullWidth('1980-05-17')}`)).toBe('Born 1980');
    expect(maskMessage(`Mail max${u(0x200b)}@exa${u(0xe0041)}mple.org`)).toBe(
      'Mail m***@example.org',
    );
  });

  it('keeps line breaks and tabs between tokens', () => {
    expect(maskMessage('a\tmax@example.org\nb')).toBe('a\tm***@example.org\nb');
  });
});

describe('maskErrorDescription', () => {
  const described = (message: string): ErrorDescription =>
    Object.freeze({ code: 'upstream', message });

  it('masks the message and keeps code and missing rights', () => {
    const description: ErrorDescription = Object.freeze({
      code: 'permission',
      message: 'Ask max.mustermann@example.org for the right.',
      missingRights: Object.freeze([
        Object.freeze({ module: 'churchdb', right: 'view' }),
      ]),
    });
    const masked = maskErrorDescription(description, 'standard');
    expect(masked).toEqual({
      code: 'permission',
      message: 'Ask m***@example.org for the right.',
      missingRights: [{ module: 'churchdb', right: 'view' }],
    });
    expect(Object.isFrozen(masked)).toBe(true);
  });

  it('masks for every level but off, also for one it does not know', () => {
    const description = described('Call 000 123 45 67');
    expect(maskErrorDescription(description, 'off')).toBe(description);
    expect(maskErrorDescription(description, 'strict').message).toBe(
      'Call 000 1** ** **',
    );
    expect(
      maskErrorDescription(description, 'unknown' as 'standard').message,
    ).toBe('Call 000 1** ** **');
  });

  it('returns a description without contact data as it is', () => {
    const description = describeError(undefined);
    expect(maskErrorDescription(description, 'standard')).toBe(description);
  });

  it('takes the fixed sentence when the masked message grows too long', () => {
    const fits = `${'x'.repeat(maxMessageLength - 12)} a@b.example`;
    expect(fits).toHaveLength(maxMessageLength);
    expect(maskErrorDescription(described(fits), 'standard').message).toBe(
      fixedSentences.upstream,
    );
    const shorter = `${'x'.repeat(maxMessageLength - 15)} a@b.example`;
    expect(
      maskErrorDescription(described(shorter), 'standard').message,
    ).toHaveLength(maxMessageLength);
  });
});
