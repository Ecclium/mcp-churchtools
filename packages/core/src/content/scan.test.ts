import { describe, expect, it } from 'vitest';

import { freeTextMarkers, maskedValue } from '../redaction/index.js';
import {
  checkReadableText,
  contactKey,
  contactKeyOf,
  contactKeysOf,
  hasMask,
  hasWebAddress,
} from './scan.js';

const none: ReadonlySet<string> = new Set();

// A pseudonym of the form of the level strict, synthetic.
const pseudonym = `p1_${'a'.repeat(20)}${'2'.repeat(19)}`;

describe('hasWebAddress', () => {
  it('finds a scheme, www. and a domain with letters at its end', () => {
    expect(hasWebAddress('https://example.org')).toBe(true);
    expect(hasWebAddress('ftp://x')).toBe(true);
    expect(hasWebAddress('HTTPS://EXAMPLE')).toBe(true);
    expect(hasWebAddress('www.1')).toBe(true);
    expect(hasWebAddress('(WWW.1')).toBe(true);
    expect(hasWebAddress('Mehr unter gemeinde.example.')).toBe(true);
    expect(hasWebAddress('gemeinde.example/seite')).toBe(true);
    expect(hasWebAddress('Siehe bericht.pdf')).toBe(true);
    expect(hasWebAddress('St.Gallen')).toBe(true);
    expect(hasWebAddress('münster.example')).toBe(true);
    expect(hasWebAddress('教会.example')).toBe(true);
  });

  it('leaves abbreviations, dates, numbers and verses', () => {
    for (const text of [
      'z.B. am 01.11.2026 um 19.30',
      'd.h. u.a. usw.',
      'Mt.5 und Ps.23',
      'v1.2.3',
      'awww.1',
      'x.d und x.de1',
      'bericht.pdf-Datei',
      '.ch am Anfang',
      'Ende .',
      'Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Max Muster.',
    ]) {
      expect(hasWebAddress(text)).toBe(false);
    }
  });

  it('ends the name of a host only at a space or ASCII punctuation', () => {
    for (const before of ['(', ',', '"', ')', '!', '_', '/']) {
      expect(hasWebAddress(`${before}.de`)).toBe(false);
    }
    // linkify-it takes symbols and every other script into a host.
    for (const before of ['a+', '$', '«', '→', '😀']) {
      expect(hasWebAddress(`${before}.de`)).toBe(true);
    }
    expect(hasWebAddress('x.рф')).toBe(true);
  });

  it('finds an @ before a host with a dot, which a renderer links', () => {
    expect(hasWebAddress('a@a.a')).toBe(true);
    // linkify-it links it as an e-mail address, the check of contact data
    // does not count it as one.
    expect(hasWebAddress('Treffpunkt@19.30')).toBe(true);
    expect(hasWebAddress('Treffpunkt @ 19.30')).toBe(false);
    expect(hasWebAddress('x@y und @a.a')).toBe(false);
    expect(hasWebAddress('a@ b')).toBe(false);
  });
});

describe('hasWebAddress, ways without a dot after a word', () => {
  it('finds a top level in punycode or after a sign beyond ASCII', () => {
    expect(hasWebAddress('Siehe beispiel.xn--p1ai/pfad')).toBe(true);
    expect(hasWebAddress('BEISPIEL.XN--P1AI')).toBe(true);
    expect(hasWebAddress('beispiel.example\u20142026')).toBe(true);
    expect(hasWebAddress('beispiel.example\u00bb2')).toBe(true);
    expect(hasWebAddress('x.\u2028\u2028 und a@b.\u2029 und a@b.')).toBe(false);
    expect(hasWebAddress('a@b.\u00fc')).toBe(true);
  });

  it('finds // before a host, mailto: and xmpp:', () => {
    expect(hasWebAddress('Siehe //localhost')).toBe(true);
    expect(hasWebAddress('//a.b/pfad')).toBe(true);
    expect(hasWebAddress('MailTo:max@localhost')).toBe(true);
    expect(hasWebAddress('xmpp:max')).toBe(true);
    expect(hasWebAddress('und // oder')).toBe(false);
    expect(hasWebAddress('Termin: 19 Uhr')).toBe(false);
  });

  it('reads www. at its place after a letter whose lower case is longer', () => {
    expect(hasWebAddress('\u0130 www.123')).toBe(true);
    expect(hasWebAddress('\u0130 wwx.123')).toBe(false);
  });
});

describe('hasMask', () => {
  it('finds the markers and masks of the redaction', () => {
    expect(hasMask(`Kontakt: ${maskedValue}`)).toBe(true);
    for (const marker of Object.values(freeTextMarkers)) {
      expect(hasMask(`Kontakt: ${marker}`)).toBe(true);
    }
    expect(hasMask('m***@example.org')).toBe(true);
    expect(hasMask('+41 00 *** ** **')).toBe(true);
    expect(hasMask('000 1** ** **')).toBe(true);
    expect(hasMask('<<data-a1b2c3d4e5f6a7b8>>')).toBe(true);
    expect(hasMask('<</data-a1b2c3d4e5f6a7b8>>')).toBe(true);
    expect(hasMask(`Person ${pseudonym}`)).toBe(true);
    expect(hasMask(`p1_kurz und ${pseudonym}`)).toBe(true);
  });

  it('leaves a single asterisk, an asterisk after a gap and a short pseudonym', () => {
    expect(hasMask('2 * 3 = 6')).toBe(false);
    expect(hasMask('1 - / . **')).toBe(false);
    expect(hasMask(`${pseudonym.slice(0, -1)}!`)).toBe(false);
    expect(hasMask(`p1_${'A'.repeat(39)}`)).toBe(false);
  });
});

describe('checkReadableText on signs that hide a number', () => {
  it('reads past selectors of variants and blank signs', () => {
    expect(checkReadableText('Tel. 0\ufe0f00 000\ufe0f12 34', none)).toEqual([
      'contact',
    ]);
    expect(checkReadableText('Tel. 000\u2800000 12 34', none)).toEqual([
      'contact',
    ]);
    expect(checkReadableText('Tel.\u2028000 000 12 34', none)).toEqual([
      'contact',
    ]);
  });
});

describe('contactKey and contactKeyOf', () => {
  it('compares an e-mail address without case and a number by its signs', () => {
    expect(
      contactKey('Mail: Info@Example.ORG', {
        kind: 'email',
        start: 6,
        end: 22,
      }),
    ).toBe('info@example.org');
    expect(contactKeyOf('000 000 12 34')).toBe(contactKeyOf('000-000-12-34'));
    expect(contactKeyOf('+41 00 000 12 34')).toBe('+41000001234');
    expect(contactKeyOf('Info@Example.org')).toBe('info@example.org');
  });

  it('takes exactly one value that fills the entry', () => {
    expect(contactKeyOf('Pfarramt')).toBeUndefined();
    expect(contactKeyOf('Tel. 000 000 12 34')).toBeUndefined();
    expect(contactKeyOf('a@example.org b@example.org')).toBeUndefined();
    expect(contactKeyOf('')).toBeUndefined();
  });
});

describe('contactKeysOf', () => {
  it('gives the key of every value and leaves out what is no single value', () => {
    expect(
      contactKeysOf(['Info@example.org', 'Pfarramt', '000-000-12-34']),
    ).toEqual(new Set(['info@example.org', '0000001234']));
  });
});

describe('checkReadableText', () => {
  it('names a web address, a mask and contact data the policy does not list', () => {
    expect(checkReadableText('Mehr unter gemeinde.example', none)).toEqual([
      'webAddress',
    ]);
    expect(checkReadableText(`Max ${maskedValue}`, none)).toEqual(['masked']);
    expect(checkReadableText('Tel. 000 000 12 34', none)).toEqual(['contact']);
    expect(checkReadableText('Ein Satz.', none)).toEqual([]);
  });

  it('lets a listed contact value stand, also an e-mail address with its domain', () => {
    const contacts = new Set(
      ['sekretariat@example.org', '000 000 12 34'].map(
        (value) => contactKeyOf(value) as string,
      ),
    );
    expect(
      checkReadableText(
        'Fragen an Sekretariat@example.org oder 000-000-12-34.',
        contacts,
      ),
    ).toEqual([]);
    expect(checkReadableText('Fragen an andere@example.org', contacts)).toEqual(
      ['contact'],
    );
    expect(
      checkReadableText(
        'sekretariat@example.org und gemeinde.example',
        contacts,
      ),
    ).toEqual(['webAddress']);
  });
});
