import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  boundaryBytes,
  chooseBoundary,
  drawBoundary,
  maxBoundaryDraws,
  type RandomBytes,
  wrapInEnvelope,
} from './envelope.js';

// A source that returns the given byte lists in turn.
const fixed = (...lists: number[][]): RandomBytes => {
  let next = 0;
  return (size) => {
    expect(size).toBe(boundaryBytes);
    const list = lists[next] ?? [];
    next += 1;
    return Uint8Array.from(list);
  };
};

const bytesA = [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18];
const bytesB = [0x00, 0x01, 0x02, 0x03, 0xfc, 0xfd, 0xfe, 0xff];

describe('drawBoundary', () => {
  it('writes the bytes as lowercase hex', () => {
    expect(drawBoundary(fixed(bytesA))).toBe('a1b2c3d4e5f60718');
    expect(drawBoundary(fixed(bytesB))).toBe('00010203fcfdfeff');
  });

  it('draws a new boundary from node:crypto each time', () => {
    const first = drawBoundary(randomBytes);
    expect(first).toHaveLength(2 * boundaryBytes);
    expect(drawBoundary(randomBytes)).not.toBe(first);
  });

  it.each([
    ['too few bytes', () => new Uint8Array(boundaryBytes - 1)],
    ['too many bytes', () => new Uint8Array(boundaryBytes + 1)],
    ['an array of numbers', () => [...bytesA] as unknown as Uint8Array],
    ['nothing', () => undefined as unknown as Uint8Array],
  ])('refuses a source that returns %s', (_, random) => {
    expect(() => drawBoundary(random)).toThrow(TypeError);
  });
});

describe('chooseBoundary', () => {
  it('takes the first boundary the result does not hold', () => {
    expect(chooseBoundary('{"note":"Text"}', fixed(bytesA))).toBe(
      'a1b2c3d4e5f60718',
    );
  });

  it('draws again when the result holds the boundary', () => {
    const result = JSON.stringify({ note: 'x a1b2c3d4e5f60718 y' });
    expect(chooseBoundary(result, fixed(bytesA, bytesB))).toBe(
      '00010203fcfdfeff',
    );
  });

  it('gives up after the last draw that clashes', () => {
    const lists = Array.from({ length: maxBoundaryDraws }, () => bytesA);
    expect(() =>
      chooseBoundary('a1b2c3d4e5f60718', fixed(...lists, bytesB)),
    ).toThrow(TypeError);
    const fits = Array.from({ length: maxBoundaryDraws - 1 }, () => bytesA);
    expect(chooseBoundary('a1b2c3d4e5f60718', fixed(...fits, bytesB))).toBe(
      '00010203fcfdfeff',
    );
  });
});

describe('wrapInEnvelope', () => {
  it('puts the text between the markers of the boundary', () => {
    expect(wrapInEnvelope('Text', 'a1b2c3d4e5f60718')).toBe(
      '<<data-a1b2c3d4e5f60718>>Text<</data-a1b2c3d4e5f60718>>',
    );
    expect(wrapInEnvelope('', 'a1b2c3d4e5f60718')).toBe(
      '<<data-a1b2c3d4e5f60718>><</data-a1b2c3d4e5f60718>>',
    );
  });
});
