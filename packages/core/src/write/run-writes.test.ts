import { describe, expect, it } from 'vitest';

import { addRunWrite, createRunWrites, runWriteCount } from './run-writes.js';

// The counter of the writes of one run, for the limit per run of the
// policy (ADR 0032). Like a proof, only the core makes and changes one.

const counter = 'write:ct_wiki_page_append_section:wiki_category:12';
const other =
  'write:ct_wiki_page_update:wiki_page:12/0000000a-0000-4000-8000-000000000001';

// What code outside the core could try with a counter it holds.
const lookalikes = (value: object): unknown[] => [
  {},
  { __ecclium: 'RunWrites' },
  Object.create(value) as object,
  new Proxy(value, {}),
  { ...value },
  JSON.parse(JSON.stringify(value)) as unknown,
  new Map([[counter, 0]]),
  null,
  undefined,
  'writes',
  0,
];

describe('the writes of a run', () => {
  it('count from 0, each counter apart', () => {
    const writes = createRunWrites();
    expect(runWriteCount(writes, counter)).toBe(0);
    expect(addRunWrite(writes, counter)).toBe(1);
    expect(addRunWrite(writes, counter)).toBe(2);
    expect(runWriteCount(writes, counter)).toBe(2);
    expect(runWriteCount(writes, other)).toBe(0);
    expect(addRunWrite(writes, other)).toBe(1);
    expect(runWriteCount(writes, counter)).toBe(2);
  });

  it('count each run apart', () => {
    const first = createRunWrites();
    const second = createRunWrites();
    addRunWrite(first, counter);
    expect(runWriteCount(first, counter)).toBe(1);
    expect(runWriteCount(second, counter)).toBe(0);
  });

  it('show nothing of themselves to code that holds them', () => {
    const writes = createRunWrites();
    addRunWrite(writes, counter);
    expect(Object.keys(writes)).toEqual([]);
    expect(Object.getOwnPropertyNames(writes)).toEqual([]);
    expect(Object.getOwnPropertySymbols(writes)).toEqual([]);
    expect(JSON.stringify(writes)).toBe('{}');
    expect(Object.isFrozen(writes)).toBe(true);
  });

  it('are told apart from every lookalike, a proxy and a copy included', () => {
    const writes = createRunWrites();
    addRunWrite(writes, counter);
    for (const value of lookalikes(writes)) {
      expect(runWriteCount(value, counter)).toBeUndefined();
      expect(addRunWrite(value, counter)).toBeUndefined();
    }
    // The lookalikes counted nothing on the counter they copy.
    expect(runWriteCount(writes, counter)).toBe(1);
  });

  it('can be neither made nor counted through their class', () => {
    const writes = createRunWrites();
    const Class = (writes as object).constructor as unknown as {
      new (key: symbol): object;
      count(key: symbol, value: unknown, counter: string): unknown;
      add(key: symbol, value: unknown, counter: string): unknown;
    };
    expect(() => new Class(Symbol('ecclium.run-writes'))).toThrow(TypeError);
    expect(
      Class.count(Symbol('ecclium.run-writes'), writes, counter),
    ).toBeUndefined();
    expect(
      Class.add(Symbol('ecclium.run-writes'), writes, counter),
    ).toBeUndefined();
    expect(() => {
      (Class as { add: unknown }).add = () => 0;
    }).toThrow(TypeError);
    expect(Object.isFrozen(Class)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(writes))).toBe(true);
    // Trying through the class counted nothing.
    expect(runWriteCount(writes, counter)).toBe(0);
  });
});
