import { bearerTokensCodes } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import { maxOutputLength } from '../output/index.js';
import { isTextLine } from '../send.js';
import {
  createdText,
  germanDay,
  lastUseText,
  listHeader,
  revokedText,
  rotatedText,
  stateText,
  tokensFileText,
  tokenTexts,
} from './texts.js';

// The fixed texts, without the dynamic ones that hold a day of the
// calendar, whose year has four digits.
const fixed: readonly string[] = [
  ...Object.values(tokenTexts),
  ...bearerTokensCodes.flatMap((code) => [
    tokensFileText(code),
    tokensFileText(code, 'tokens[2].expiresAt'),
    tokensFileText(code, undefined, 3),
  ]),
  listHeader.join('  '),
  ...[-1, 0, 1, 2, 30, 31].map(stateText),
  lastUseText(undefined),
  lastUseText(null),
  revokedText('buero', 1),
  revokedText('buero', 2),
];

const dynamic: readonly string[] = [
  createdText('buero', ['read'], '2027-05-25'),
  createdText('buero', ['read', 'write'], '2027-05-25'),
  rotatedText('buero', '2027-05-25', '2026-12-03'),
  rotatedText('buero', '2027-05-25', undefined),
];

// The same rules as for the other texts of the command line
// (output/texts.test.ts).
const allowed = /^[ -~«»‹›äöüÄÖÜ]+$/;

describe('the texts of ecclium token', () => {
  it('keep every line to one line of allowed characters', () => {
    for (const line of [...fixed, ...dynamic]) {
      expect(isTextLine(line, maxOutputLength), line).toBe(true);
      expect(line, line).toMatch(allowed);
    }
  });

  it('follow the rules of the brand', () => {
    for (const line of [...fixed, ...dynamic]) {
      expect(line, line).not.toMatch(/[ß—–!"„“”'‚‘’]/);
      expect(line.split('‹').length, line).toBe(line.split('›').length);
      expect(line, line).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
    }
    for (const line of fixed) {
      expect(line, line).not.toMatch(/\d{4}/);
    }
  });

  it('name the field or the line of a problem of the file', () => {
    expect(
      tokensFileText('bearer_tokens_invalid', 'tokens[2].expiresAt'),
    ).toContain('(Feld ‹tokens[2].expiresAt›)');
    expect(tokensFileText('bearer_tokens_yaml_syntax', undefined, 3)).toContain(
      '(Zeile 3)',
    );
  });

  it('write a day in the German form', () => {
    expect(germanDay('2027-05-25')).toBe('25.05.2027');
  });

  it('say how long a token still holds', () => {
    expect(stateText(-1)).toBe('abgelaufen');
    expect(stateText(0)).toBe('gilt nur noch heute');
    expect(stateText(1)).toBe('gilt noch bis morgen');
    expect(stateText(30)).toBe('läuft in 30 Tagen ab');
    expect(stateText(31)).toBe('gilt');
  });

  it('name the last use as a day, as nie or as unbekannt', () => {
    expect(lastUseText('2026-11-26')).toBe('26.11.2026');
    expect(lastUseText(null)).toBe('nie');
    expect(lastUseText(undefined)).toBe('unbekannt');
  });
});
