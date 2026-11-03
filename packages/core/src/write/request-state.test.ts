import { describe, expect, it } from 'vitest';

import {
  argumentsDigestOf,
  confirmationStateVersion,
  principalDigestOf,
  readConfirmationState,
} from './request-state.js';

const hex = (digit: string, length: number): string => digit.repeat(length);

const valid = {
  v: 1,
  tool: 'ct_example_note_write',
  planHash: hex('a', 64),
  nonce: hex('b', 32),
  principal: hex('c', 64),
  arguments: hex('d', 64),
};

describe('the state of a question', () => {
  it('reads a state of its form, frozen', () => {
    expect(confirmationStateVersion).toBe(1);
    const state = readConfirmationState({ ...valid });
    expect(state).toEqual(valid);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it.each([
    ['another version', { ...valid, v: 2 }],
    ['no version', { ...valid, v: undefined }],
    ['a field more', { ...valid, round: 1 }],
    ['a tool of another form', { ...valid, tool: 'wiki_write' }],
    ['a hash in capitals', { ...valid, planHash: hex('A', 64) }],
    ['a short hash', { ...valid, planHash: hex('a', 63) }],
    ['a long nonce', { ...valid, nonce: hex('b', 33) }],
    [
      'a hash of the principal that is no hex',
      { ...valid, principal: hex('g', 64) },
    ],
    ['a hash of the input as a number', { ...valid, arguments: 1 }],
  ])('counts a state with %s as none', (_name, value) => {
    expect(readConfirmationState(value)).toBeUndefined();
  });

  it.each([null, undefined, 'state', 1, [], [valid]])(
    'counts %j as none',
    (value) => {
      expect(readConfirmationState(value)).toBeUndefined();
    },
  );
});

describe('the hash of the principal', () => {
  const actor = { kind: 'service', id: 'stdio:local-stdio' } as const;

  it('is SHA-256 in hex and the same for the same principal', () => {
    const digest = principalDigestOf('default', actor);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(principalDigestOf('default', { ...actor })).toBe(digest);
  });

  it('differs for another tenant, kind or ID of the actor', () => {
    const digest = principalDigestOf('default', actor);
    expect(principalDigestOf('demo-tenant', actor)).not.toBe(digest);
    expect(principalDigestOf('default', { ...actor, kind: 'user' })).not.toBe(
      digest,
    );
    expect(principalDigestOf('default', { ...actor, id: 'other' })).not.toBe(
      digest,
    );
  });

  it('lets no value end one field and start the next', () => {
    expect(principalDigestOf('ab', { kind: 'service', id: 'c' })).not.toBe(
      principalDigestOf('a', { kind: 'bservice' as 'service', id: 'c' }),
    );
  });
});

describe('the hash of the input', () => {
  it('does not depend on the order of keys', () => {
    expect(argumentsDigestOf({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      argumentsDigestOf({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
  });

  it('leaves out a field that holds undefined', () => {
    expect(argumentsDigestOf({ a: 1, b: undefined })).toBe(
      argumentsDigestOf({ a: 1 }),
    );
  });

  it('differs for another value, another order of a list and another type', () => {
    const digest = argumentsDigestOf({ a: [1, 2], b: 'x', c: true });
    for (const other of [
      { a: [2, 1], b: 'x', c: true },
      { a: [1, 2], b: 'y', c: true },
      { a: [1, 2], b: 'x', c: false },
      { a: ['1', '2'], b: 'x', c: true },
      { a: [1, 2], b: 'x', c: true, d: null },
    ]) {
      expect(argumentsDigestOf(other)).not.toBe(digest);
    }
  });

  it('takes a lone value and nothing as well', () => {
    expect(argumentsDigestOf(undefined)).toBe(argumentsDigestOf(null));
    expect(argumentsDigestOf('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
