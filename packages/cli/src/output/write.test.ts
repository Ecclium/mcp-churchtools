import { describe, expect, it } from 'vitest';

import type { WriteSyncFn } from '../send.js';
import { createOutput, maxOutputLength } from './index.js';

interface Call {
  readonly fd: number;
  readonly argumentCount: number;
}

const decoder = new TextDecoder();

const join = (chunks: readonly Uint8Array[]): string => {
  const all = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return decoder.decode(all);
};

/**
 * A fake writeSync that records each call before it answers, and keeps
 * the bytes it took per descriptor. By default it takes everything.
 */
const recorder = (
  answer: (fd: number, length: number, index: number) => number = (
    _fd,
    length,
  ) => length,
): {
  writeSync: WriteSyncFn;
  calls: Call[];
  written: (fd: number) => string;
} => {
  const calls: Call[] = [];
  const taken = new Map<number, Uint8Array[]>();
  const writeSync: WriteSyncFn = (...args) => {
    const [fd, buffer, offset, length] = args;
    const index = calls.length;
    calls.push({ fd, argumentCount: args.length });
    const count = answer(fd, length, index);
    const chunks = taken.get(fd) ?? [];
    chunks.push(buffer.slice(offset, offset + Math.max(0, count)));
    taken.set(fd, chunks);
    return count;
  };
  return { writeSync, calls, written: (fd) => join(taken.get(fd) ?? []) };
};

const failWith =
  (code: string, onFd: number) =>
  (fd: number, length: number): number => {
    if (fd === onFd) throw Object.assign(new Error(code), { code });
    return length;
  };

// Lone surrogate: cannot stand in a source file as such.
const loneSurrogate = String.fromCharCode(0xd800);

describe('createOutput', () => {
  it('writes a line to stdout on fd 1 and to stderr on fd 2', () => {
    const { writeSync, calls, written } = recorder();
    const output = createOutput({ writeSync });
    expect(output.stdout('Die Konfiguration ist gültig.')).toBe(true);
    expect(output.stderr('Prüfen Sie ‹ECCLIUM_READ_ONLY›.')).toBe(true);
    expect(written(1)).toBe('Die Konfiguration ist gültig.\n');
    expect(written(2)).toBe('Prüfen Sie ‹ECCLIUM_READ_ONLY›.\n');
    expect(calls.map(({ fd }) => fd)).toEqual([1, 2]);
    for (const call of calls) {
      // A fifth argument, a position, would fail on a pipe.
      expect(call.argumentCount).toBe(4);
    }
  });

  it('continues a partial write that ends inside a letter', () => {
    // «Gr» takes two bytes and «ö» two more: three cuts the letter.
    const { writeSync, calls, written } = recorder((_fd, length, index) =>
      index === 0 ? 3 : length,
    );
    expect(createOutput({ writeSync }).stdout('Grösse.')).toBe(true);
    expect(written(1)).toBe('Grösse.\n');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['a line break', 'Eine\nZeile.'],
    ['a carriage return', 'Eine\rZeile.'],
    ['a tab', 'Eine\tZeile.'],
    ['an escape sequence', 'Eine \u001b[31mZeile.'],
    ['an escape at the end', 'Eine Zeile.\u001b'],
    ['a letter with an accent', 'Caf\u00e9.'],
    ['DEL', 'Eine\u007fZeile.'],
    ['a C1 control character', 'Eine\u009bZeile.'],
    ['a zero-width space', 'Eine\u200bZeile.'],
    ['a mark that turns the direction', 'Eine\u202eZeile.'],
    ['an isolate', 'Eine\u2068Zeile.'],
    ['the Arabic letter mark', 'Eine\u061cZeile.'],
    ['a paragraph separator', 'Eine\u2029Zeile.'],
    ['a word joiner', 'Eine\u2060Zeile.'],
    ['a byte order mark', '\ufeffEine Zeile.'],
    ['a lone surrogate', `Eine ${loneSurrogate} Zeile.`],
    ['nothing', ''],
    ['too many characters', 'a'.repeat(maxOutputLength + 1)],
  ])('leaves out a line with %s on both streams', (_, value) => {
    const { writeSync, calls, written } = recorder();
    const output = createOutput({ writeSync });
    expect(output.stdout(value)).toBe(false);
    expect(output.stderr(value)).toBe(false);
    expect(calls).toEqual([]);
    // The tripwire closes nothing: the next line goes out.
    expect(output.stdout('Die nächste Zeile.')).toBe(true);
    expect(written(1)).toBe('Die nächste Zeile.\n');
  });

  it('takes a line of the longest length', () => {
    const { writeSync } = recorder();
    expect(
      createOutput({ writeSync }).stdout('a'.repeat(maxOutputLength)),
    ).toBe(true);
    expect(maxOutputLength).toBe(4000);
  });

  it('leaves out a value that is no string', () => {
    const { writeSync, calls } = recorder();
    const output = createOutput({ writeSync });
    expect(output.stdout(42 as unknown as string)).toBe(false);
    expect(output.stderr(undefined as unknown as string)).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ['EPIPE', 1],
    ['EBADF', 1],
    ['EPIPE', 2],
    ['EBADF', 2],
  ])('after %s on fd %i stops only that stream', (code, fd) => {
    const { writeSync, calls, written } = recorder(failWith(code, fd));
    const output = createOutput({ writeSync });
    const [closed, open] =
      fd === 1
        ? [output.stdout, output.stderr]
        : [output.stderr, output.stdout];
    expect(closed('Eins.')).toBe(false);
    expect(closed('Zwei.')).toBe(false);
    expect(open('Drei.')).toBe(true);
    expect(open('Vier.')).toBe(true);
    expect(calls.filter((call) => call.fd === fd)).toHaveLength(1);
    expect(written(fd === 1 ? 2 : 1)).toBe('Drei.\nVier.\n');
  });

  it('ends a line that stays cut off and writes nothing more to that stream', () => {
    const again = (): number => {
      throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
    };
    const { writeSync, calls, written } = recorder((fd, length, index) => {
      if (fd === 2) return length;
      if (index === 0) return 3;
      if (index < 4) return again();
      return length;
    });
    const output = createOutput({ writeSync });
    expect(output.stdout('Eins.')).toBe(false);
    expect(output.stdout('Zwei.')).toBe(false);
    expect(output.stderr('Drei.')).toBe(true);
    expect(written(1)).toBe('Ein\n');
    expect(written(2)).toBe('Drei.\n');
    expect(calls.filter((call) => call.fd === 1)).toHaveLength(5);
  });

  it('reports a line it could not write at all and goes on', () => {
    const { writeSync, calls } = recorder((_fd, length, index) =>
      index < 4 ? 0 : length,
    );
    const output = createOutput({ writeSync });
    expect(output.stdout('Eins.')).toBe(false);
    expect(output.stdout('Zwei.')).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('never throws for a failed write and keeps the stream open', () => {
    const { writeSync, calls } = recorder((_fd, length, index) => {
      if (index === 0) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return length;
    });
    const output = createOutput({ writeSync });
    expect(output.stderr('Eins.')).toBe(false);
    expect(output.stderr('Zwei.')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('refuses a writeSync that is no function', () => {
    expect(() =>
      createOutput({ writeSync: 'fd' as unknown as WriteSyncFn }),
    ).toThrow(new TypeError('The output needs a writeSync function.'));
  });

  it('gives a frozen output', () => {
    expect(Object.isFrozen(createOutput(recorder()))).toBe(true);
    expect(Object.isFrozen(createOutput())).toBe(true);
  });
});
