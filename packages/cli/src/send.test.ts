import { describe, expect, it } from 'vitest';

import { isTextLine, maxAttempts, sendAll, type WritePart } from './send.js';

const bytes = new TextEncoder().encode('Zeile mit Umlauten: äöü\n');

const errorWith = (code: string): Error =>
  Object.assign(new Error(code), { code });

interface Call {
  readonly offset: number;
  readonly length: number;
}

/** A write that answers each call from a list and records the calls. */
const scripted = (
  answers: readonly ((call: Call) => number)[],
): { write: WritePart; calls: Call[] } => {
  const calls: Call[] = [];
  const write: WritePart = (_buffer, offset, length) => {
    const call = { offset, length };
    calls.push(call);
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error('called too often');
    return answer(call);
  };
  return { write, calls };
};

describe('sendAll', () => {
  it('writes everything in one call when the stream takes it', () => {
    const { write, calls } = scripted([({ length }) => length]);
    expect(sendAll(bytes, write)).toEqual({
      sent: bytes.length,
      closed: false,
    });
    expect(calls).toEqual([{ offset: 0, length: bytes.length }]);
  });

  it('continues a partial write at its offset', () => {
    const { write, calls } = scripted([
      () => 5,
      () => 7,
      ({ length }) => length,
    ]);
    expect(sendAll(bytes, write).sent).toBe(bytes.length);
    expect(calls).toEqual([
      { offset: 0, length: bytes.length },
      { offset: 5, length: bytes.length - 5 },
      { offset: 12, length: bytes.length - 12 },
    ]);
  });

  it('tries EAGAIN again at once, up to the most calls', () => {
    const again = (): number => {
      throw errorWith('EAGAIN');
    };
    const { write, calls } = scripted(
      Array.from({ length: maxAttempts }, () => again),
    );
    expect(sendAll(bytes, write)).toEqual({ sent: 0, closed: false });
    expect(calls).toHaveLength(maxAttempts);
    expect(maxAttempts).toBe(4);
  });

  it('stops after the most calls also when each call makes progress', () => {
    const { write, calls } = scripted(
      Array.from({ length: maxAttempts + 1 }, () => () => 1),
    );
    expect(sendAll(bytes, write)).toEqual({ sent: maxAttempts, closed: false });
    expect(calls).toHaveLength(maxAttempts);
  });

  it('counts EAGAIN and progress alike towards the most calls', () => {
    const again = (): number => {
      throw errorWith('EAGAIN');
    };
    const { write, calls } = scripted([
      () => 1,
      again,
      () => 1,
      again,
      () => 1,
    ]);
    expect(sendAll(bytes, write)).toEqual({ sent: 2, closed: false });
    expect(calls).toHaveLength(maxAttempts);
  });

  it('writes the rest after EAGAIN', () => {
    const { write } = scripted([
      () => {
        throw errorWith('EAGAIN');
      },
      ({ length }) => length,
    ]);
    expect(sendAll(bytes, write).sent).toBe(bytes.length);
  });

  it.each(['EPIPE', 'EBADF'])('reports the stream closed after %s', (code) => {
    const { write, calls } = scripted([
      () => 3,
      () => {
        throw errorWith(code);
      },
    ]);
    expect(sendAll(bytes, write)).toEqual({ sent: 3, closed: true });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['another error', () => errorWith('EIO')],
    ['an error without a code', () => new Error('failed')],
    ['a string', () => 'EPIPE'],
    ['a proxy with the code EPIPE', () => new Proxy(errorWith('EPIPE'), {})],
    [
      'a code behind a getter',
      () =>
        Object.defineProperty(new Error('failed'), 'code', {
          get: () => 'EPIPE',
        }),
    ],
  ])('stops without closing after %s', (_, thrown) => {
    const { write, calls } = scripted([
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the stream may throw anything
        throw thrown();
      },
    ]);
    expect(sendAll(bytes, write)).toEqual({ sent: 0, closed: false });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a negative count', -1],
    ['a fraction', 1.5],
    ['more than it was given', bytes.length + 1],
    ['zero', 0],
  ])('counts %s as no progress', (_, count) => {
    const { write, calls } = scripted(
      Array.from({ length: maxAttempts }, () => () => count),
    );
    expect(sendAll(bytes, write).sent).toBe(0);
    expect(calls).toHaveLength(maxAttempts);
  });

  it('gives a frozen result', () => {
    const { write } = scripted([({ length }) => length]);
    expect(Object.isFrozen(sendAll(bytes, write))).toBe(true);
  });
});

describe('isTextLine', () => {
  // Printable ASCII, the umlauts and the quotes «» and ‹›.
  const shown = new Set([
    ...Array.from({ length: 0x7f - 0x20 }, (_, index) => 0x20 + index),
    0xab,
    0xbb,
    0xc4,
    0xd6,
    0xdc,
    0xe4,
    0xf6,
    0xfc,
    0x2039,
    0x203a,
  ]);

  // Each character alone, first, in the middle and last, so that a loop
  // that skips a position cannot pass.
  it('takes exactly the allowed characters of the basic plane, in any place', () => {
    const wrong: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      for (const line of [char, `${char}ab`, `a${char}b`, `ab${char}`]) {
        if (isTextLine(line, 3) !== shown.has(code)) wrong.push(code);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['U+1F600', 0x1f600],
    ['U+E0041', 0xe0041],
    ['U+10FFFF', 0x10ffff],
  ])('refuses the character %s beyond the basic plane', (_, code) => {
    expect(isTextLine(`a${String.fromCodePoint(code)}b`, 4)).toBe(false);
  });

  it.each([
    ['no string', 42, 10, false],
    ['nothing', '', 10, false],
    ['the longest line', 'abc', 3, true],
    ['one character too many', 'abcd', 3, false],
  ])('judges %s', (_, value, maxLength, expected) => {
    expect(isTextLine(value, maxLength)).toBe(expected);
  });
});
