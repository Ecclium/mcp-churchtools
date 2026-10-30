import { assertNoCanary, makeCanaries } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { maxResultBytes, resultBytes } from '../pipeline/stages.js';
import {
  fieldMask,
  foreignJsonCost,
  maskForeignText,
  maxForeignJsonCost,
  renderForeignJson,
} from './foreign-json.js';

// The mask of an answer of the escape hatch (ADR 0067): by the name of a
// field and by the form of a text, never every date, and a limit that
// keeps the result below 64 KiB as the pipeline counts it.

const zeroWidth = String.fromCodePoint(0x200b);
const fullWidth = (text: string): string =>
  Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e
      ? String.fromCodePoint(code + 0xfee0)
      : character;
  }).join('');

const render = (root: unknown) => {
  const written = renderForeignJson(root, 'standard');
  if (!written.ok) throw new Error(written.reason);
  return JSON.parse(written.text) as unknown;
};

describe('fieldMask', () => {
  it.each([
    ['email', 'email'],
    ['emails', 'email'],
    ['requesterEmail', 'email'],
    ['site_mail', 'email'],
    ['E-Mail', 'email'],
    ['phone', 'phone'],
    ['phonePrivate', 'phone'],
    ['phone_work', 'phone'],
    ['memberlist_telefonhandy', 'phone'],
    ['Handy', 'phone'],
    ['mobile', 'phone'],
    ['Mobil', 'phone'],
    ['fax', 'phone'],
    ['mobiles', 'phone'],
    ['faxes', 'phone'],
    ['randomUrl', 'secret'],
    ['randomString', 'secret'],
    ['iCalSourceUrl', 'secret'],
    ['loginToken', 'secret'],
    ['mail_smtp_args_password', 'secret'],
    ['churchdb_mailjet_apisecret', 'secret'],
    ['apiKey', 'secret'],
    ['birthday', 'birthdate'],
    ['dateOfBirth', 'birthdate'],
    ['birth_date', 'birthdate'],
    ['Geburtsdatum', 'birthdate'],
    ['geburtstag', 'birthdate'],
    ['memberlist_birthday', 'birthdate'],
  ])('reads %s as %s', (name, mask) => {
    expect(fieldMask(name)).toBe(mask);
  });

  it.each([
    'birthName',
    'birthplace',
    'mailSendDate',
    'name',
    'id',
    'mobileGroups',
    '',
  ])('asks no mask for %s', (name) => {
    expect(fieldMask(name)).toBeUndefined();
  });
});

describe('maskForeignText', () => {
  it('masks addresses and phone numbers in running text', () => {
    expect(
      maskForeignText(
        'Fragen an max.mustermann@example.org oder 000 123 45 67, sonst (000) 123 45 67 oder +41 00 123 45 67.',
      ),
    ).toBe(
      'Fragen an m***@example.org oder 000 1** ** **, sonst (000) 1** ** ** oder +41 00 *** ** **.',
    );
  });

  it.each([
    ['0000-30-12-34-56', '0000-**-**-**-**'],
    ['0000/1/23/45/67', '0000/*/**/**/**'],
    ['05.17.1980', '05.17.****'],
  ])('masks %s, which only looks like a date at its start', (text, result) => {
    expect(maskForeignText(`Tel: ${text}`)).toBe(`Tel: ${result}`);
  });

  it('masks a phone number with typographic hyphens or en dashes as a whole', () => {
    const hyphen = String.fromCodePoint(0x2011);
    const dash = String.fromCodePoint(0x2013);
    expect(maskForeignText(`Tel: 000${hyphen}123${hyphen}45${hyphen}67`)).toBe(
      'Tel: [masked]',
    );
    expect(maskForeignText(`Tel: 000${dash}123 45 67`)).toBe('Tel: [masked]');
  });

  it.each([
    '2026-10-30T10:00:00Z',
    '2026-10-30',
    'Am 01.10.2026 um 10:00',
    '1/2/2026',
    'CCLI 1234567',
    'Raum 12, Saal 3',
    'Lied 0815',
    'Ab 0,5 Liter',
  ])('leaves %s as it is', (text) => {
    expect(maskForeignText(text)).toBe(text);
  });

  it('finds full-width forms and addresses with hidden characters', () => {
    expect(maskForeignText(fullWidth('000 123 45 67'))).toBe('000 1** ** **');
    expect(maskForeignText(`max${zeroWidth}.mustermann@example.org`)).toBe(
      'm***@example.org',
    );
  });

  it('gives back a text without contact data unchanged, also with forms NFKC would change', () => {
    const text = `Ein ${String.fromCodePoint(0xfb01)}xer Termin in m${String.fromCodePoint(0xb2)}`;
    expect(maskForeignText(text)).toBe(text);
  });
});

describe('renderForeignJson', () => {
  it('masks fields by name, also in lists and nested objects', () => {
    expect(
      render({
        data: {
          id: 7,
          firstName: 'Max',
          email: 'max.mustermann@example.org',
          emails: [{ email: 'max.mustermann@example.org', contactLabelId: 1 }],
          phonePrivate: '+41 00 123 45 67',
          mobiles: ['000 123 45 67'],
          phones: ['1234567'],
          birthday: '1980-05-17',
          birthName: 'Muster',
          hasEmail: true,
          editBirthday: false,
          fax: null,
        },
        meta: { count: 1 },
      }),
    ).toEqual({
      data: {
        id: 7,
        firstName: 'Max',
        email: 'm***@example.org',
        emails: [{ email: 'm***@example.org', contactLabelId: 1 }],
        phonePrivate: '+41 00 *** ** **',
        mobiles: ['000 1** ** **'],
        phones: ['1234***'],
        birthday: '1980',
        birthName: 'Muster',
        hasEmail: true,
        editBirthday: false,
        fax: null,
      },
      meta: { count: 1 },
    });
  });

  it('passes the mask of a field on to numbers right under it and to texts in objects below', () => {
    expect(
      render({
        phone: 41001234567,
        birthday: { date: '1980-05-17', shown: true },
        emails: [{ address: 'privat@', contactLabelId: 3, primary: true }],
        mobiles: [41001234567],
        hasEmail: true,
        editBirthday: false,
        email: null,
      }),
    ).toEqual({
      phone: '4100*******',
      birthday: { date: '1980', shown: true },
      emails: [{ address: '[masked]', contactLabelId: 3, primary: true }],
      mobiles: ['4100*******'],
      hasEmail: true,
      editBirthday: false,
      email: null,
    });
  });

  it('hides the whole value of a field with a secret, also below it', () => {
    expect(
      render({
        calendar: {
          id: 2,
          name: 'Gottesdienste',
          randomUrl: 'a1b2c3d4e5f6',
          iCalSourceUrl: 'https://example.church.tools/ical/x',
          isPublic: true,
        },
        settings: { apiKey: 1234, tokens: { reading: 'abc' } },
      }),
    ).toEqual({
      calendar: {
        id: 2,
        name: 'Gottesdienste',
        randomUrl: '[masked]',
        iCalSourceUrl: '[masked]',
        isPublic: true,
      },
      settings: { apiKey: '[masked]', tokens: { reading: '[masked]' } },
    });
  });

  it('masks a value under a field it cannot read as a whole and keeps an empty one', () => {
    expect(
      render({
        email: 'kein Eintrag',
        phone: '12',
        birthday: 'Mai',
        mobile: '',
      }),
    ).toEqual({
      email: '[masked]',
      phone: '[masked]',
      birthday: '[masked]',
      mobile: '',
    });
  });

  it('masks by form in every other text and in keys, and keeps dates', () => {
    expect(
      render({
        note: 'Bitte max.mustermann@example.org anrufen: 000 123 45 67',
        startDate: '2026-10-30T10:00:00Z',
        'max.mustermann@example.org': 3,
        list: ['000 123 45 67', 4, null],
      }),
    ).toEqual({
      note: 'Bitte m***@example.org anrufen: 000 1** ** **',
      startDate: '2026-10-30T10:00:00Z',
      'm***@example.org': 3,
      list: ['000 1** ** **', 4, null],
    });
  });

  it('keeps a key named __proto__ as a plain key', () => {
    const root = JSON.parse(
      '{"__proto__":{"email":"max.mustermann@example.org"}}',
    ) as unknown;
    const written = renderForeignJson(root, 'standard');
    expect(written).toEqual({
      ok: true,
      text: '{"__proto__":{"email":"m***@example.org"}}',
    });
  });

  it('refuses an answer in which two keys are the same after the mask', () => {
    expect(
      renderForeignJson(
        { 'max@example.org': 1, 'mia@example.org': 2 },
        'standard',
      ),
    ).toEqual({ ok: false, reason: 'collision' });
  });

  it('masks with every level but off, also with one it does not know', () => {
    const root = { email: 'max.mustermann@example.org' };
    expect(renderForeignJson(root, 'off')).toEqual({
      ok: true,
      text: '{"email":"max.mustermann@example.org"}',
    });
    for (const level of ['standard', 'strict', 'later'] as const) {
      expect(renderForeignJson(root, level as 'standard')).toEqual({
        ok: true,
        text: '{"email":"m***@example.org"}',
      });
    }
  });

  it('lets no canary through in a field with contact data or in free text', () => {
    const canaries = makeCanaries();
    const root = {
      email: canaries.email.value,
      phoneWork: canaries.phone.value,
      note: `Kontakt: ${canaries.email.value}, ${canaries.phone.value}`,
      [canaries.email.value]: canaries.phone.value,
    };
    const written = renderForeignJson(root, 'standard');
    expect(written.ok).toBe(true);
    assertNoCanary(written, [canaries.email, canaries.phone], 'masked answer');
  });

  it('counts the cost as the pipeline counts a text and refuses beyond the limit', () => {
    expect(foreignJsonCost('a')).toBe(10);
    expect(foreignJsonCost('"')).toBe(14);
    expect(foreignJsonCost('ä')).toBe(12);
    // {"a":"x…x"} costs 2 × (n + 8) + 4 + 2 + 4 × 2 + 2 bytes: its JSON
    // with four escaped quotes, then that JSON once more.
    const cost = (n: number) =>
      foreignJsonCost(JSON.stringify({ a: 'x'.repeat(n) }));
    let n = 0;
    while (cost(n + 1) <= maxForeignJsonCost) n += 1024;
    while (cost(n + 1) > maxForeignJsonCost) n -= 1;
    const fits = renderForeignJson({ a: 'x'.repeat(n + 1) }, 'standard');
    expect(fits.ok).toBe(true);
    expect(renderForeignJson({ a: 'x'.repeat(n + 2) }, 'standard')).toEqual({
      ok: false,
      reason: 'too_large',
    });
    // A result with that text, an operationId and the envelope stays
    // within what the pipeline lets out.
    const boundary = '0123456789abcdef';
    const text = fits.ok ? fits.text : '';
    expect(
      resultBytes({
        operationId:
          'get-calendars-calendarId-appointments-appointmentId-startDate',
        json: `<<data-${boundary}>>${text}<</data-${boundary}>>`,
      }),
    ).toBeLessThanOrEqual(maxResultBytes);
  });
});
