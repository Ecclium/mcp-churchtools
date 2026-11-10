import { describe, expect, it } from 'vitest';

import {
  createWriteHalt,
  haltWrites,
  isWriteHalt,
  writesHalted,
} from './write-halt.js';

// The halt of writes of a process (ADR 0029). Like the counter of a run,
// only the core makes and sets one, and nothing lifts it.

// What code outside the core could try with a halt it holds.
const lookalikes = (value: object): unknown[] => [
  {},
  { __ecclium: 'WriteHalt' },
  Object.create(value) as object,
  new Proxy(value, {}),
  { ...value },
  JSON.parse(JSON.stringify(value)) as unknown,
  null,
  undefined,
  false,
  0,
];

describe('the halt of writes', () => {
  it('starts open and stays halted once set', () => {
    const halt = createWriteHalt();
    expect(isWriteHalt(halt)).toBe(true);
    expect(writesHalted(halt)).toBe(false);
    expect(haltWrites(halt)).toBe(true);
    expect(writesHalted(halt)).toBe(true);
    expect(haltWrites(halt)).toBe(true);
    expect(writesHalted(halt)).toBe(true);
  });

  it('halts each one apart', () => {
    const first = createWriteHalt();
    const second = createWriteHalt();
    haltWrites(first);
    expect(writesHalted(first)).toBe(true);
    expect(writesHalted(second)).toBe(false);
  });

  it('shows nothing of itself to code that holds it', () => {
    const halt = createWriteHalt();
    haltWrites(halt);
    expect(Object.keys(halt)).toEqual([]);
    expect(Object.getOwnPropertyNames(halt)).toEqual([]);
    expect(Object.getOwnPropertySymbols(halt)).toEqual([]);
    expect(JSON.stringify(halt)).toBe('{}');
    expect(Object.isFrozen(halt)).toBe(true);
  });

  it('reads every lookalike as halted and sets none of them', () => {
    const halt = createWriteHalt();
    for (const value of lookalikes(halt)) {
      expect(isWriteHalt(value)).toBe(false);
      expect(writesHalted(value)).toBe(true);
      expect(haltWrites(value)).toBe(false);
    }
    // The lookalikes set nothing on the halt they copy.
    expect(writesHalted(halt)).toBe(false);
  });

  it('can be neither made, read nor set through its class', () => {
    const halt = createWriteHalt();
    const Class = (halt as object).constructor as unknown as {
      new (key: symbol): object;
      halted(key: symbol, value: unknown): unknown;
      halt(key: symbol, value: unknown): unknown;
    };
    expect(() => new Class(Symbol('ecclium.write-halt'))).toThrow(TypeError);
    expect(Class.halted(Symbol('ecclium.write-halt'), halt)).toBeUndefined();
    expect(Class.halt(Symbol('ecclium.write-halt'), halt)).toBe(false);
    expect(() => {
      (Class as { halted: unknown }).halted = () => false;
    }).toThrow(TypeError);
    expect(Object.isFrozen(Class)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(halt))).toBe(true);
    expect(writesHalted(halt)).toBe(false);
  });
});
