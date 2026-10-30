import {
  type AuditFileCode,
  auditFileCodes,
  quotaFolderCodes,
  type QuotaFolderCode,
  type RefusalReason,
  refusalReasons,
  type ToolsetName,
  toolsetNames,
} from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import { maxNoticeLength } from '../notices/index.js';
import { isTextLine } from '../send.js';
import {
  auditFileMessage,
  auditFileText,
  emptyToolsetMessage,
  emptyToolsetText,
  type Message,
  quotaFolderMessage,
  quotaFolderText,
  refusalMessage,
  refusalText,
  type StartNoticeCode,
  startMessage,
  startText,
  toolsetsMessage,
  toolsetsText,
} from './index.js';

// The three parts as the catalog joins them.
const textOf = (message: Message): string =>
  `${message.what} ${message.why} ${message.action}`;

const startCodes: readonly StartNoticeCode[] = [
  'usage',
  'internal',
  'audit_file_required',
];

/** Every message of the module, with a label for the report. */
const everyMessage: [string, Message][] = [
  ...startCodes.map((code): [string, Message] => [code, startMessage(code)]),
  ...refusalReasons.map((reason): [string, Message] => [
    `the refusal ${reason}`,
    refusalMessage(reason),
  ]),
  ...auditFileCodes.map((code): [string, Message] => [
    `the audit file ${code}`,
    auditFileMessage(code),
  ]),
  ...quotaFolderCodes.map((code): [string, Message] => [
    `the folder quota ${code}`,
    quotaFolderMessage(code),
  ]),
  ['one toolset', toolsetsMessage(['wiki'])],
  ['every toolset', toolsetsMessage(toolsetNames)],
  ...toolsetNames.map((name): [string, Message] => [
    `the toolset ${name} without tools`,
    emptyToolsetMessage(name),
  ]),
];

const everyText: [string, string][] = [
  ...startCodes.map((code): [string, string] => [code, startText(code)]),
  ...refusalReasons.map((reason): [string, string] => [
    `the refusal ${reason}`,
    refusalText(reason),
  ]),
  ...auditFileCodes.map((code): [string, string] => [
    `the audit file ${code}`,
    auditFileText(code),
  ]),
  ...quotaFolderCodes.map((code): [string, string] => [
    `the folder quota ${code}`,
    quotaFolderText(code),
  ]),
  ['every toolset', toolsetsText(toolsetNames)],
  ...toolsetNames.map((name): [string, string] => [
    `the toolset ${name} without tools`,
    emptyToolsetText(name),
  ]),
];

// Characters chapter 9 of brand/README.md rules out, the no-break space
// among them. It is made from its code point, so that no hidden character
// stands in the source.
const ruledOut = new RegExp(`[ß—–!"„“”'‚‘’${String.fromCodePoint(0xa0)}]`);

describe('the texts of the start over stdio', () => {
  it.each(everyMessage)(
    'says what, why and what to do for %s',
    (_, message) => {
      expect(Object.keys(message)).toEqual(['what', 'why', 'action']);
      expect(Object.isFrozen(message)).toBe(true);
      for (const part of [message.what, message.why, message.action]) {
        expect(part.length).toBeGreaterThan(10);
        expect(part).toMatch(/^[A-ZÄÖÜ‹«]/);
        expect(part).toMatch(/\.$/);
        expect(part).not.toMatch(/\s{2}|^\s|\s$/);
      }
    },
  );

  // Chapter 9 of brand/README.md: «Sie», ss, quotes «so», no em dash, no
  // exclamation mark, numbers from 1000 up as 4'096, none of the words it
  // lists.
  it.each(everyMessage)(
    'follows the rules of the brand in %s',
    (_, message) => {
      const text = textOf(message);
      expect(text.replace(/(?<=\d)'(?=\d{3})/g, '')).not.toMatch(ruledOut);
      expect(text).not.toMatch(/\d{4}/);
      expect(text.split('«').length).toBe(text.split('»').length);
      expect(text.split('‹').length).toBe(text.split('›').length);
      expect(text).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
      expect(text).not.toMatch(
        /revolutionär|nahtlos|einzigartig|smart|magisch|mühelos|einfach|100 % sicher/i,
      );
    },
  );

  // The start notices leave out a text that breaks their tripwire, so a
  // text of this module that broke it would never reach the operator. The
  // tripwire allows printable ASCII, the umlauts and the quotes «» and ‹›.
  it.each(everyText)('passes the tripwire of the notices in %s', (_, text) => {
    expect(isTextLine(text, maxNoticeLength)).toBe(true);
  });

  it('joins the three parts with one space each', () => {
    for (const code of startCodes) {
      expect(startText(code)).toBe(textOf(startMessage(code)));
    }
    for (const reason of refusalReasons) {
      expect(refusalText(reason)).toBe(textOf(refusalMessage(reason)));
    }
    for (const code of auditFileCodes) {
      expect(auditFileText(code)).toBe(textOf(auditFileMessage(code)));
    }
  });

  it('gives every reason of the audit file a text of its own, without a path', () => {
    const whats = auditFileCodes.map((code) => auditFileMessage(code).what);
    expect(new Set(whats).size).toBe(auditFileCodes.length);
    for (const code of auditFileCodes) {
      expect(auditFileText(code)).toContain('ECCLIUM_STATE_DIR');
      expect(auditFileText(code)).not.toMatch(/\/[a-z]/);
    }
    expect(startText('audit_file_required')).toContain('‹ECCLIUM_STATE_DIR›');
  });

  it('gives every reason of the folder quota a text of its own, without a path', () => {
    const whats = quotaFolderCodes.map((code) => quotaFolderMessage(code).what);
    expect(new Set(whats).size).toBe(quotaFolderCodes.length);
    for (const code of quotaFolderCodes) {
      expect(quotaFolderText(code)).toContain('ECCLIUM_STATE_DIR');
      expect(quotaFolderText(code)).toContain('bricht ab');
      expect(quotaFolderText(code)).not.toMatch(/\/[a-z]/);
    }
    expect(() => quotaFolderText('toString' as QuotaFolderCode)).toThrow(
      new TypeError('The quota folder code is unknown.'),
    );
  });

  it('gives every reason of the registry a text of its own', () => {
    const whats = refusalReasons.map((reason) => refusalMessage(reason).what);
    expect(new Set(whats).size).toBe(refusalReasons.length);
    expect(refusalReasons).toContain('plugin_reserved');
    expect(refusalMessage('plugin_reserved').what).toContain('vorbehalten');
  });

  // The registry refuses an input schema that is no closed object and one
  // that cannot be advertised as JSON Schema with the same reason.
  it('names both cases of an input schema the registry refuses', () => {
    const { what } = refusalMessage('tool_input');
    expect(what).toContain('kein geschlossenes Objekt');
    expect(what).toContain('nicht als JSON Schema melden');
  });

  it('says that a refusal is no mistake of the configuration', () => {
    for (const reason of refusalReasons) {
      expect(refusalMessage(reason).why).toContain('Ecclium startet deshalb');
      expect(refusalMessage(reason).action).toContain(
        'nicht in Ihrer Konfiguration',
      );
    }
  });

  // An argument can hold a token, so the text for a wrong call names only
  // the command.
  it('names only the command in the text for a wrong call', () => {
    const text = startText('usage');
    expect(text).toContain('‹ecclium stdio›');
    expect(text).toContain('weil darin ein Token stehen könnte');
    expect(startText('internal')).toContain('internen Fehler');
  });

  it.each([
    ['toString', 'toString'],
    ['no string', 7],
  ])('refuses %s as a reason or a code', (_, value) => {
    expect(() => refusalText(value as RefusalReason)).toThrow(
      new TypeError('The refusal reason is unknown.'),
    );
    expect(() => startText(value as StartNoticeCode)).toThrow(
      new TypeError('The start code is unknown.'),
    );
    expect(() => auditFileText(value as AuditFileCode)).toThrow(
      new TypeError('The audit file code is unknown.'),
    );
  });

  it('names the toolsets of the start as German prose', () => {
    expect(toolsetsMessage(['persons']).what).toBe(
      'Eingeschaltet ist das Toolset ‹persons›.',
    );
    expect(toolsetsMessage(['persons']).why).toContain('nur seine Tools');
    expect(toolsetsMessage(['persons', 'wiki']).what).toBe(
      'Eingeschaltet sind die Toolsets ‹persons› und ‹wiki›.',
    );
    expect(toolsetsMessage(toolsetNames).what).toBe(
      'Eingeschaltet sind die Toolsets ‹persons›, ‹events›, ‹calendars›, ‹wiki›, ‹songs› und ‹docs›.',
    );
    expect(toolsetsMessage(['persons', 'wiki']).why).toContain(
      'nur ihre Tools',
    );
    expect(toolsetsText(['wiki'])).toBe(textOf(toolsetsMessage(['wiki'])));
    expect(Object.isFrozen(toolsetsMessage(['wiki']))).toBe(true);
  });

  it('names a toolset without tools and how to turn it off', () => {
    const message = emptyToolsetMessage('songs');
    expect(message.what).toBe(
      'Das Toolset ‹songs› bietet in dieser Version keine Tools an.',
    );
    expect(message.action).toContain('‹ECCLIUM_TOOLSETS›');
    expect(emptyToolsetText('songs')).toBe(textOf(message));
  });

  // Only a name of the list of toolsets reaches a text.
  it.each([
    ['no toolset', []],
    ['all', ['all']],
    ['a name that is no toolset', ['groups']],
    ['toString', ['toString']],
    ['a string', 'persons'],
    ['no array', 7],
  ])('refuses %s as toolsets', (_, value) => {
    expect(() => toolsetsText(value as readonly ToolsetName[])).toThrow(
      new TypeError('The toolsets are unknown.'),
    );
  });

  it.each([
    ['all', 'all'],
    ['toString', 'toString'],
    ['no string', 7],
  ])('refuses %s as a toolset without tools', (_, value) => {
    expect(() => emptyToolsetText(value as ToolsetName)).toThrow(
      new TypeError('The toolsets are unknown.'),
    );
  });

  // The start notices take only texts of the catalog. A function that made
  // one from any three strings would open them to free text.
  it('exports no function that makes a text from free text', async () => {
    expect(Object.keys(await import('./start.js')).sort()).toEqual([
      'auditFileMessage',
      'auditFileText',
      'emptyToolsetMessage',
      'emptyToolsetText',
      'quotaFolderMessage',
      'quotaFolderText',
      'refusalMessage',
      'refusalText',
      'startMessage',
      'startText',
      'toolsetsMessage',
      'toolsetsText',
    ]);
  });
});
