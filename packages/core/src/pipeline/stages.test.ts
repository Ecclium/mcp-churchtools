import { describe, expect, it } from 'vitest';

import type { ShapeNode } from '../registry/index.js';
import { mapLeaves, markUntrusted, redact, resultBytes } from './stages.js';

const leaf = (dataClass?: 'email' | 'none'): ShapeNode => ({
  kind: 'leaf',
  dataClass,
});

const root: ShapeNode = {
  kind: 'object',
  fields: {
    email: leaf('email'),
    list: { kind: 'array', element: leaf() },
    pair: { kind: 'tuple', items: [leaf('none'), leaf()] },
    nested: { kind: 'object', fields: { a: leaf() } },
  },
};

describe('mapLeaves', () => {
  it('applies the step to every leaf with its class and freezes every copy', () => {
    const seen: unknown[] = [];
    const copy = mapLeaves(
      {
        email: 'max.mustermann@example.org',
        list: [1, 2],
        pair: ['a', null],
        nested: null,
        unknown: 'dropped',
      },
      root,
      (value, dataClass) => {
        seen.push([value, dataClass]);
        return value;
      },
    ) as Record<string, unknown>;
    expect(copy).toEqual({
      email: 'max.mustermann@example.org',
      list: [1, 2],
      pair: ['a', null],
      nested: null,
    });
    expect(seen).toEqual([
      ['max.mustermann@example.org', 'email'],
      [1, undefined],
      [2, undefined],
      ['a', 'none'],
      [null, undefined],
    ]);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.isFrozen(copy.list)).toBe(true);
    expect(Object.isFrozen(copy.pair)).toBe(true);
  });

  it('passes a missing container on as it is', () => {
    expect(
      mapLeaves(undefined, { kind: 'array', element: leaf() }, () => 'x'),
    ).toBeUndefined();
  });
});

describe('redact and markUntrusted', () => {
  it('copy the result along its shape and leave leaves unchanged for now', () => {
    const value = { email: 'max.mustermann@example.org', nested: { a: 'x' } };
    expect(markUntrusted(redact(value, root), root)).toEqual(value);
  });
});

describe('resultBytes', () => {
  it('counts UTF-8 bytes of the JSON', () => {
    expect(resultBytes({ name: 'Ä' })).toBe(13);
  });
});
