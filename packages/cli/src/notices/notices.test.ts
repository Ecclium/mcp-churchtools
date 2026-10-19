import {
  configProblemCodes,
  configWarningCodes,
  proxyVariableName,
  tlsVariableName,
  unsupportedVariableNames,
  variableNames,
} from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import {
  type MessageText,
  problemText,
  warningText,
} from '../messages/index.js';
import { isTextLine, type WriteSyncFn } from '../send.js';
import { maxNoticeLength, writeNotices } from './index.js';

interface Call {
  readonly fd: number;
  readonly argumentCount: number;
  readonly text: string;
}

const decoder = new TextDecoder();

/** A fake writeSync that records what it wrote, by default everything. */
const recorder = (
  answer: (length: number, index: number) => number = (length) => length,
): { writeSync: WriteSyncFn; calls: Call[]; written: () => string } => {
  const calls: Call[] = [];
  const out = { text: '' };
  const writeSync: WriteSyncFn = (...args) => {
    const [fd, buffer, offset, length] = args;
    const index = calls.length;
    calls.push({
      fd,
      argumentCount: args.length,
      text: decoder.decode(buffer.subarray(offset, offset + length)),
    });
    const count = answer(length, index);
    out.text += decoder.decode(
      buffer.subarray(offset, offset + Math.max(0, count)),
    );
    return count;
  };
  return { writeSync, calls, written: () => out.text };
};

const text = (value: string): MessageText => value as MessageText;

// Lone surrogate: cannot stand in a source file as such.
const loneSurrogate = String.fromCharCode(0xd800);

// Every name the loader can report with a problem: the known variables,
// the names of later phases and of a proxy, the variable of TLS, the
// variable with the options of Node.js and the longest unknown name it
// shows.
const reportedNames: readonly string[] = [
  ...variableNames,
  ...unsupportedVariableNames,
  proxyVariableName,
  tlsVariableName,
  'NODE_OPTIONS',
  `ECCLIUM_${'A'.repeat(64)}`,
];

// Every text the catalog gives for the names the loader reports: each
// problem without a name and with each such name, and each warning.
const catalog: MessageText[] = [
  ...configProblemCodes.flatMap((code) => [
    problemText({ code }),
    ...reportedNames.map((variable) => problemText({ code, variable })),
  ]),
  ...configWarningCodes.map((code) => warningText(code)),
];

const done = { complete: true, torn: false };
const incomplete = { complete: false, torn: false };

describe('writeNotices', () => {
  it('lets every text the catalog gives through the tripwire', () => {
    expect(catalog.length).toBeGreaterThan(600);
    for (const text of catalog) {
      expect(isTextLine(text, maxNoticeLength), text).toBe(true);
    }
  });

  it('writes each text of the catalog as one line to fd 2', () => {
    const { writeSync, calls, written } = recorder();
    expect(writeNotices(catalog, { writeSync })).toEqual(done);
    expect(written()).toBe(`${catalog.join('\n')}\n`);
    expect(calls).toHaveLength(catalog.length);
    for (const call of calls) {
      expect(call.fd).toBe(2);
      // A fifth argument, a position, would fail on a pipe.
      expect(call.argumentCount).toBe(4);
    }
  });

  it('writes German letters and quotes as UTF-8', () => {
    const { writeSync, written } = recorder();
    writeNotices([text('Prüfen Sie ‹ECCLIUM_READ_ONLY› und «Grösse».')], {
      writeSync,
    });
    expect(written()).toBe('Prüfen Sie ‹ECCLIUM_READ_ONLY› und «Grösse».\n');
  });

  it('continues a partial write', () => {
    const { writeSync, written } = recorder((length, index) =>
      index === 0 ? 4 : length,
    );
    expect(writeNotices([text('Eine Zeile.')], { writeSync })).toEqual(done);
    expect(written()).toBe('Eine Zeile.\n');
  });

  it.each([
    ['a line break', 'Eine\nZeile.'],
    ['a carriage return', 'Eine\rZeile.'],
    ['an escape sequence', 'Eine \u001b[31mZeile.'],
    ['an escape at the end', 'Eine Zeile.\u001b'],
    ['a letter with an accent', 'Caf\u00e9.'],
    ['DEL', 'Eine\u007fZeile.'],
    ['a C1 control character', 'Eine\u0085Zeile.'],
    ['a zero-width space', 'Eine\u200bZeile.'],
    ['a mark that turns the direction', 'Eine\u202eZeile.'],
    ['an isolate', 'Eine\u2066Zeile.'],
    ['the Arabic letter mark', 'Eine\u061cZeile.'],
    ['a line separator', 'Eine\u2028Zeile.'],
    ['a soft hyphen', 'Eine\u00adZeile.'],
    ['a word joiner', 'Eine\u2060Zeile.'],
    ['a Cyrillic lookalike', 'Eine Z\u0435ile.'],
    ['a tag character', `Eine ${String.fromCodePoint(0xe0041)} Zeile.`],
    ['a byte order mark', '\ufeffEine Zeile.'],
    ['a lone surrogate', `Eine ${loneSurrogate} Zeile.`],
    ['nothing', ''],
    ['too many characters', 'a'.repeat(maxNoticeLength + 1)],
  ])('leaves out a text with %s and reports it', (_, value) => {
    const { writeSync, written } = recorder();
    expect(
      writeNotices([text(value), text('Die nächste Zeile.')], { writeSync }),
    ).toEqual(incomplete);
    expect(written()).toBe('Die nächste Zeile.\n');
  });

  it('takes a text of the longest length', () => {
    const { writeSync } = recorder();
    expect(
      writeNotices([text('a'.repeat(maxNoticeLength))], { writeSync }),
    ).toEqual(done);
  });

  it('leaves out a value that is no string', () => {
    const { writeSync, calls } = recorder();
    expect(writeNotices([42 as unknown as MessageText], { writeSync })).toEqual(
      incomplete,
    );
    expect(calls).toEqual([]);
  });

  it.each(['EPIPE', 'EBADF'])('stops for good after %s', (code) => {
    const { writeSync, calls } = recorder(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(writeNotices([text('Eins.'), text('Zwei.')], { writeSync })).toEqual(
      incomplete,
    );
    expect(calls).toHaveLength(1);
  });

  const again = (): number => {
    throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
  };

  it('ends a line that stays cut off with a line break and stops', () => {
    const { writeSync, calls, written } = recorder((length, index) => {
      if (index === 0) return 3;
      if (index < 4) return again();
      return length;
    });
    expect(writeNotices([text('Eins.'), text('Zwei.')], { writeSync })).toEqual(
      incomplete,
    );
    expect(written()).toBe('Ein\n');
    expect(calls).toHaveLength(5);
    expect(calls.at(-1)).toEqual({ fd: 2, argumentCount: 4, text: '\n' });
  });

  // A full pipe is what cuts a line, and it may still be full for the line
  // break. The caller then has to know that the next line would continue
  // the cut one.
  it('reports a line that stays cut off when the line break fails too', () => {
    const { writeSync, calls, written } = recorder((_length, index) =>
      index === 0 ? 3 : again(),
    );
    expect(writeNotices([text('Eins.'), text('Zwei.')], { writeSync })).toEqual(
      { complete: false, torn: true },
    );
    expect(written()).toBe('Ein');
    expect(calls).toHaveLength(8);
  });

  it('reports a text it could not write at all and goes on', () => {
    const { writeSync, calls } = recorder((length, index) =>
      index < 4 ? 0 : length,
    );
    expect(writeNotices([text('Eins.'), text('Zwei.')], { writeSync })).toEqual(
      incomplete,
    );
    expect(calls.at(-1)?.text).toBe('Zwei.\n');
  });

  it('gives a frozen result', () => {
    const { writeSync } = recorder();
    expect(Object.isFrozen(writeNotices([], { writeSync }))).toBe(true);
  });

  it('refuses texts that are no list and a writeSync that is no function', () => {
    expect(() => writeNotices('Eins.' as unknown as MessageText[])).toThrow(
      'Notices need a list of texts and a writeSync.',
    );
    expect(() =>
      writeNotices([], { writeSync: 'fd' as unknown as WriteSyncFn }),
    ).toThrow('Notices need a list of texts and a writeSync.');
  });
});
