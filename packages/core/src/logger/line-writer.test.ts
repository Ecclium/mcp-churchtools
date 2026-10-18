import { readdirSync, readFileSync } from 'node:fs';

import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  createStderrWriter,
  defaultMaxAttempts,
  maxLineLength,
  type WriteSyncFn,
} from './index.js';

interface Call {
  readonly fd: number;
  readonly offset: number;
  readonly length: number;
  readonly argumentCount: number;
  /** The bytes it was asked to write. */
  readonly text: string;
  /** The bytes it answered to have written. */
  readonly sent: string;
}

type Answer = (call: Omit<Call, 'sent'>, index: number) => number;

/** A fake writeSync that records each call and answers as told. */
function fakeWriteSync(answer: Answer = (call) => call.length): {
  readonly calls: Call[];
  readonly writeSync: WriteSyncFn;
} {
  const calls: Call[] = [];
  const decoder = new TextDecoder();
  const writeSync = (...args: unknown[]): number => {
    const [fd, buffer, offset, length] = args as Parameters<WriteSyncFn>;
    const request = {
      fd,
      offset,
      length,
      argumentCount: args.length,
      text: decoder.decode(buffer.subarray(offset, offset + length)),
    };
    let count: unknown = 0;
    try {
      count = answer(request, calls.length);
      return count as number;
    } finally {
      const taken =
        typeof count === 'number' && Number.isInteger(count) && count > 0
          ? Math.min(count, length)
          : 0;
      calls.push({
        ...request,
        sent: decoder.decode(buffer.subarray(offset, offset + taken)),
      });
    }
  };
  return { calls, writeSync };
}

const systemError = (code: string): Error =>
  Object.assign(new Error(`${code}: write failed`), { code });

const line = '{"level":"info","event":"started"}';

describe('createStderrWriter', () => {
  it('writes a line with its line break in one call of four arguments on fd 2', () => {
    const fake = fakeWriteSync();
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    expect(writer.write(line)).toBe(true);
    expect(fake.calls).toEqual([
      {
        fd: 2,
        offset: 0,
        length: line.length + 1,
        argumentCount: 4,
        text: `${line}\n`,
        sent: `${line}\n`,
      },
    ]);
    expect(writer.stats()).toEqual({
      written: 1,
      failed: 0,
      partial: 0,
      rejected: 0,
      reentrant: 0,
      closed: false,
    });
  });

  it('continues a partial write at its offset', () => {
    const fake = fakeWriteSync((call, index) =>
      index === 0 ? 10 : call.length,
    );
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    writer.write(line);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.offset).toBe(10);
    expect(fake.calls[1]?.length).toBe(line.length + 1 - 10);
    expect(fake.calls.map((call) => call.sent).join('')).toBe(`${line}\n`);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 0, partial: 0 });
  });

  it('gives up after its attempts on EAGAIN without waiting, and tries the next line again', () => {
    let busy = true;
    const fake = fakeWriteSync((call) => {
      if (busy) throw systemError('EAGAIN');
      return call.length;
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    const started = performance.now();
    expect(writer.write(line)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
    expect(fake.calls).toHaveLength(defaultMaxAttempts);
    expect(writer.stats()).toMatchObject({
      written: 0,
      failed: 1,
      closed: false,
    });
    busy = false;
    expect(writer.write(line)).toBe(true);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 1 });
  });

  it.each([
    ['no progress', 0],
    ['a negative count', -1],
    ['NaN', Number.NaN],
    ['a fraction', 1.5],
    ['more than it was given', 1000],
    ['a string', '5'],
  ])(
    'treats %s as no progress and stays within its attempts',
    (_what, count) => {
      const fake = fakeWriteSync(() => count as number);
      const writer = createStderrWriter({
        writeSync: fake.writeSync,
        maxAttempts: 3,
      });
      writer.write(line);
      expect(fake.calls).toHaveLength(3);
      for (const call of fake.calls) {
        expect(call.offset).toBe(0);
        expect(call.length).toBe(line.length + 1);
      }
      expect(writer.stats()).toMatchObject({
        written: 0,
        failed: 1,
        partial: 0,
      });
    },
  );

  it('starts the next line on a line of its own after a lost part of a line', () => {
    let first = true;
    const fake = fakeWriteSync((call) => {
      if (first) {
        first = false;
        return 5;
      }
      if (call.offset === 5) throw systemError('EAGAIN');
      return call.length;
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    expect(writer.write(line)).toBe(false);
    expect(writer.stats()).toMatchObject({ failed: 1, partial: 1 });
    writer.write(line);
    const last = fake.calls.at(-1);
    expect(last?.text).toBe(`\n${line}\n`);
    const pieces = fake.calls
      .map((call) => call.sent)
      .join('')
      .split('\n');
    expect(pieces).toEqual([line.slice(0, 5), line, '']);
    expect(JSON.parse(pieces[1] ?? '')).toEqual({
      level: 'info',
      event: 'started',
    });
    expect(writer.stats()).toMatchObject({ written: 1, failed: 1, partial: 1 });
    writer.write(line);
    expect(fake.calls.at(-1)?.text).toBe(`${line}\n`);
  });

  it('counts a line of which only the repairing break went out as lost, not as partial', () => {
    let calls = 0;
    const fake = fakeWriteSync((call) => {
      calls += 1;
      // Four attempts per line: the first line sends 5 bytes, the second
      // only its repairing break, the third goes out whole.
      if (calls === 1) return 5;
      if (calls <= 4) throw systemError('EAGAIN');
      if (calls === 5) return 1;
      if (calls <= 8) throw systemError('EAGAIN');
      return call.length;
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    writer.write(line);
    expect(writer.stats()).toMatchObject({ failed: 1, partial: 1 });
    writer.write(line);
    expect(fake.calls[4]?.sent).toBe('\n');
    expect(writer.stats()).toMatchObject({ failed: 2, partial: 1 });
    writer.write(line);
    expect(fake.calls.at(-1)?.text).toBe(`${line}\n`);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 2, partial: 1 });
  });

  it('starts the first line on a line of its own after a torn line', () => {
    const fake = fakeWriteSync();
    const writer = createStderrWriter({
      writeSync: fake.writeSync,
      afterTornLine: true,
    });
    expect(writer.write(line)).toBe(true);
    writer.write(line);
    expect(fake.calls.map((call) => call.text)).toEqual([
      `\n${line}\n`,
      `${line}\n`,
    ]);
    // What a reader of stderr sees after a notice that lost its line break.
    const stderr = `a torn notice${fake.calls.map((call) => call.sent).join('')}`;
    expect(stderr.split('\n')).toEqual(['a torn notice', line, line, '']);
    expect(writer.stats()).toMatchObject({ written: 2, failed: 0, partial: 0 });
  });

  it('keeps the line break for the next line while the first finds no room', () => {
    let busy = true;
    const fake = fakeWriteSync((call) => {
      if (busy) throw systemError('EAGAIN');
      return call.length;
    });
    const writer = createStderrWriter({
      writeSync: fake.writeSync,
      afterTornLine: true,
    });
    expect(writer.write(line)).toBe(false);
    busy = false;
    expect(writer.write(line)).toBe(true);
    expect(fake.calls.at(-1)?.text).toBe(`\n${line}\n`);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 1, partial: 0 });
  });

  it.each([false, undefined, 'true', 1])(
    'starts the first line without a line break when afterTornLine is %j',
    (afterTornLine) => {
      const fake = fakeWriteSync();
      createStderrWriter({
        writeSync: fake.writeSync,
        afterTornLine: afterTornLine as boolean,
      }).write(line);
      expect(fake.calls.map((call) => call.text)).toEqual([`${line}\n`]);
    },
  );

  it.each(['EPIPE', 'EBADF'])('closes for good on %s', (code) => {
    const fake = fakeWriteSync(() => {
      throw systemError(code);
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    for (let index = 0; index < 101; index += 1) {
      expect(writer.write(line)).toBe(false);
    }
    expect(fake.calls).toHaveLength(1);
    expect(writer.stats()).toMatchObject({ failed: 101, closed: true });
  });

  it('loses a line on any other failure, but stays open and runs no code of the error', () => {
    const canary = makeCanary('token');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let calls = 0;
    const failures: unknown[] = [
      systemError('EIO'),
      new Error(canary.value),
      canary.value,
      revoked.proxy,
      Object.defineProperty({}, 'code', {
        get: () => {
          calls += 1;
          throw new Error(canary.value);
        },
      }),
      new Proxy(systemError('EPIPE'), {
        get: () => {
          calls += 1;
          return 'EIO';
        },
        getOwnPropertyDescriptor: () => {
          calls += 1;
          return undefined;
        },
      }),
    ];
    let index = 0;
    const fake = fakeWriteSync((call) => {
      const failure = failures[index];
      index += 1;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point is to throw values that are not errors
      if (failure !== undefined) throw failure;
      return call.length;
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    for (let count = 0; count <= failures.length; count += 1)
      writer.write(line);
    expect(fake.calls).toHaveLength(failures.length + 1);
    expect(calls).toBe(0);
    expect(writer.stats()).toMatchObject({
      written: 1,
      failed: failures.length,
      closed: false,
    });
    assertNoCanary(
      [writer.stats(), fake.calls.map((call) => call.text)],
      [canary],
      'writer',
    );
  });

  it.each([
    ['an empty line', ''],
    ['a line feed', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['an umlaut', 'gr\u00fcn'],
    ['a line separator', 'a\u2028b'],
    ['a lone surrogate', 'a\ud800'],
    ['a line one character too long', 'a'.repeat(maxLineLength + 1)],
    ['a value that is no string', 42],
  ])('refuses %s without a system call', (_what, value) => {
    const fake = fakeWriteSync();
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    expect(writer.write(value as string)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(writer.stats()).toMatchObject({ rejected: 1, written: 0 });
  });

  it('takes a line of the longest length', () => {
    const fake = fakeWriteSync();
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    writer.write('a'.repeat(maxLineLength));
    expect(writer.stats()).toMatchObject({ written: 1, rejected: 0 });
  });

  it('drops a line that comes while a line is written, and works on afterwards', () => {
    const inner: boolean[] = [];
    const fake = fakeWriteSync((call, index) => {
      if (index === 0) inner.push(writer.write('{"event":"inner"}'));
      return call.length;
    });
    const writer = createStderrWriter({ writeSync: fake.writeSync });
    writer.write(line);
    writer.write(line);
    expect(fake.calls.map((call) => call.text)).toEqual([
      `${line}\n`,
      `${line}\n`,
    ]);
    expect(writer.stats()).toMatchObject({ written: 2, reentrant: 1 });
    expect(inner).toEqual([false]);
  });

  it('gives a frozen snapshot of its counts', () => {
    const writer = createStderrWriter({ writeSync: fakeWriteSync().writeSync });
    writer.write(line);
    const stats = writer.stats();
    expect(Object.isFrozen(stats)).toBe(true);
    expect(() => {
      (stats as { written: number }).written = 7;
    }).toThrow(TypeError);
    writer.write(line);
    expect(stats.written).toBe(1);
    expect(writer.stats().written).toBe(2);
    expect(Object.isFrozen(writer)).toBe(true);
  });

  it.each([0, 17, 1.5, Number.NaN, '4'])(
    'refuses %j attempts with a fixed message',
    (maxAttempts) => {
      expect(() =>
        createStderrWriter({
          writeSync: fakeWriteSync().writeSync,
          maxAttempts: maxAttempts as number,
        }),
      ).toThrow(
        new TypeError(
          'The writer needs a writeSync function and 1 to 16 attempts.',
        ),
      );
    },
  );

  it('accepts 1 to 16 attempts and refuses a writeSync that is no function', () => {
    for (const maxAttempts of [1, 16]) {
      const fake = fakeWriteSync(() => 0);
      createStderrWriter({ writeSync: fake.writeSync, maxAttempts }).write(
        line,
      );
      expect(fake.calls).toHaveLength(maxAttempts);
    }
    expect(() =>
      createStderrWriter({ writeSync: 'fs' as unknown as WriteSyncFn }),
    ).toThrow(TypeError);
  });

  it('shares no counts or guards between two writers', () => {
    const failing = fakeWriteSync(() => {
      throw systemError('EPIPE');
    });
    const working = fakeWriteSync();
    const a = createStderrWriter({ writeSync: failing.writeSync });
    const b = createStderrWriter({ writeSync: working.writeSync });
    a.write(line);
    b.write(line);
    expect(a.stats()).toMatchObject({ written: 0, failed: 1, closed: true });
    expect(b.stats()).toMatchObject({ written: 1, failed: 0, closed: false });
  });
});

describe('the sources of the logger', () => {
  // The architecture rules allow writes to stderr in this folder. Touching
  // the stream objects of Node.js would make fd 2 non-blocking, and closing
  // fd 2 would let the next opened file take its number, so these sources
  // use neither.
  it('use no stream object of the process, no console and never close a file', () => {
    const folder = new URL('.', import.meta.url);
    const sources = readdirSync(folder).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const code = readFileSync(new URL(name, folder), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const forbidden of [
        /\bprocess\b/,
        /\bconsole\b/,
        /\bemitWarning\b/,
        /\b_rawDebug\b/,
        /\bcloseSync\b/,
        /\bclose\(/,
      ]) {
        expect(code, `${name} ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
  });
});
