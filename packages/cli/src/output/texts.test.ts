import { readdirSync, readFileSync } from 'node:fs';

import {
  type ConfigProblem,
  configProblemCodes,
  configWarningCodes,
  loadConfig,
  maxReportedProblems,
  tlsVariableName,
  tokenVariableName,
  unsupportedVariableNames,
  variableNames,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { isTextLine } from '../send.js';
import {
  helpLines,
  internalErrorText,
  maxOutputLength,
  renderConfigReport,
  usageLine,
  usageProblemTexts,
} from './index.js';

// Every name the loader can report with a problem: the known variables,
// the names of later phases, the variable of TLS, the
// variable with the options of Node.js and the longest unknown name it
// shows.
const reportedNames: readonly string[] = [
  ...variableNames,
  ...unsupportedVariableNames,
  tlsVariableName,
  'NODE_OPTIONS',
  `ECCLIUM_${'A'.repeat(64)}`,
];

// The reports a run can print, built from real loads: valid, with every
// notice of the start, invalid, and reports that hold every problem code
// without a name and with every name the loader reports.
const reports = (): readonly (readonly [string, readonly string[]])[] => {
  const token = makeCanary('token').value;
  const base = {
    ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools:8443',
    [tokenVariableName]: token,
  };
  const loaded = (environment: Record<string, string>) =>
    loadConfig({ environment, transport: 'stdio' });
  const valid = loaded({
    ...base,
    ECCLIUM_REDACTION: 'off',
    ECCLIUM_TOOLSETS: 'persons',
    ECCLIUM_STDIO_SUBJECT: 'team-a',
  });
  const invalid = loaded({ ECCLIUM_READ_ONLY: 'yes', ECCLIUM_REDONLY: 'x' });
  const problems: ConfigProblem[] = configProblemCodes.flatMap((code) => [
    { code },
    ...reportedNames.map((variable) => ({ code, variable })),
  ]);
  const every = {
    ...invalid.report,
    problems: problems.slice(0, maxReportedProblems),
    omittedProblems: problems.length - maxReportedProblems,
    warnings: [...configWarningCodes],
  };
  return [
    [
      'a valid report',
      renderConfigReport(valid.report, { valid: true, showValues: false }),
    ],
    [
      'a valid report with values',
      renderConfigReport(valid.report, { valid: true, showValues: true }),
    ],
    [
      'an invalid report',
      renderConfigReport(invalid.report, { valid: false, showValues: false }),
    ],
    [
      'a report with every problem',
      renderConfigReport(every, { valid: false, showValues: false }),
    ],
    [
      'the rest of the problems',
      renderConfigReport(
        {
          ...every,
          problems: problems.slice(maxReportedProblems),
          omittedProblems: 0,
        },
        { valid: false, showValues: false },
      ),
    ],
  ];
};

const fixedTexts: readonly (readonly [string, readonly string[]])[] = [
  ['the usage', [usageLine]],
  ['the help', helpLines],
  ['the texts for a wrong call', Object.values(usageProblemTexts)],
  ['the internal error', [internalErrorText]],
];

// Printable ASCII, the quotes «» and ‹› and the umlauts: what the tripwire
// of the writers allows, except the sharp s, which it lets through for
// foreign text and which the texts of the command line write as ss.
// Nothing else reaches a terminal, so no character can hide or turn what a
// line says.
const allowed = /^[\u0020-\u007e«»‹›äöüÄÖÜ]+$/;

describe('the texts of the output', () => {
  it.each([...fixedTexts, ...reports()])(
    'keep %s to one line of allowed characters each',
    (_, lines) => {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(isTextLine(line, maxOutputLength), line).toBe(true);
        expect(line, line).toMatch(allowed);
      }
    },
  );

  // Chapter 9 of brand/README.md: «Sie», ss, quotes «so», no em dash, no
  // exclamation mark, numbers from 1000 up as 4'096, none of the words it
  // lists. A port in an address, also in a target as name and port, is no
  // number of that kind.
  it.each([...fixedTexts, ...reports()])(
    'follow the rules of the brand in %s',
    (_, lines) => {
      for (const line of lines) {
        const text = line
          .replace(/https?:\/\/\S+/g, '')
          .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d+\b/g, '');
        expect(text.replace(/(?<=\d)'(?=\d{3})/g, ''), line).not.toMatch(
          /[ß—–!"„“”'‚‘’]/,
        );
        expect(text, line).not.toMatch(/\d{4}/);
        expect(line.split('«').length, line).toBe(line.split('»').length);
        expect(line.split('‹').length, line).toBe(line.split('›').length);
        expect(line, line).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
        expect(line, line).not.toMatch(
          /revolutionär|nahtlos|einzigartig|smart|magisch|mühelos|einfach|100 % sicher/i,
        );
      }
    },
  );

  it.each([
    ...Object.entries(usageProblemTexts),
    ['internal', internalErrorText],
  ])(
    'says in %s what happened, why and what to do, in whole sentences',
    (_, text) => {
      const sentences = text.split(/(?<=\.) /);
      expect(sentences.length).toBeGreaterThanOrEqual(3);
      for (const sentence of sentences) {
        expect(sentence).toMatch(/^[A-ZÄÖÜ‹«].*\.$/);
      }
    },
  );

  it('names both commands in the usage, the help and the text for an unknown command', () => {
    for (const text of [usageLine, usageProblemTexts.command]) {
      expect(text).toContain('ecclium stdio');
      expect(text).toContain('ecclium config check');
    }
    expect(helpLines).toContainEqual(expect.stringMatching(/^ {2}stdio +\S/));
    expect(helpLines).toContainEqual(
      expect.stringMatching(/^ {2}config check +\S/),
    );
  });

  it('repeats the usage at the start of the help', () => {
    expect(helpLines[0]).toBe(usageLine);
    expect(Object.isFrozen(helpLines)).toBe(true);
    expect(Object.isFrozen(usageProblemTexts)).toBe(true);
  });
});

// The texts of the command line write ss, never the sharp s. The tripwire
// of the writers lets it through for foreign text, so it no longer catches
// one in a text of the command line itself: no source of the package holds
// it, texts and comments alike. The tests may, for the foreign text they
// show.
describe('the sources of the command line', () => {
  it('hold no sharp s outside the tests', () => {
    const root = new URL('../', import.meta.url);
    const sharpS = String.fromCodePoint(0xdf);
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .sort();
    expect(sources).toContain('send.ts');
    const holding = sources.filter((file) =>
      readFileSync(new URL(file, root), 'utf8').includes(sharpS),
    );
    expect(holding).toEqual([]);
  });
});
