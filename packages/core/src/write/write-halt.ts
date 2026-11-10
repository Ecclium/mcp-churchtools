/**
 * The halt of writes of a process (ADR 0029): after a write whose line did
 * not reach the audit file, no later write of the process plans or
 * commits, until the process ends.
 *
 * Where it stands: the write guard of each pipeline holds one. Without one
 * from the composition root it makes its own, so the halt lives as long as
 * its pipeline, which over stdio and HTTP is as long as the process. The
 * runner builds a pipeline for each run, with the token of the account of
 * the routine (ADR 0033); it hands every such pipeline the same halt, so
 * that a later run of a daemon does not write past a line the audit lost.
 *
 * Like the counter of the writes of a run, the halt is a class with a
 * private field behind a key that only this module holds, so that no tool,
 * no engine and no plugin makes one, lifts it or passes a copy for it. A
 * halt can only be set, never lifted.
 *
 * @packageDocumentation
 */

/** The halt of writes of a process, as the write guard takes it. */
export interface WriteHalt {
  readonly __ecclium: 'WriteHalt';
}

// The key of this module; no code outside it can get it.
const key: unique symbol = Symbol('ecclium.write-halt');

class Halt {
  #halted = false;

  constructor(given: symbol) {
    if (given !== key) throw new TypeError('Only the core halts writes.');
    Object.freeze(this);
  }

  /**
   * Whether a value of this module is set.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @returns Whether it is set, or undefined for a value that is none.
   */
  static halted(given: symbol, value: unknown): boolean | undefined {
    if (given !== key || !Halt.is(value)) return undefined;
    return value.#halted;
  }

  /**
   * Sets a value of this module.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @returns Whether a value of this module was set.
   */
  static halt(given: symbol, value: unknown): boolean {
    if (given !== key || !Halt.is(value)) return false;
    value.#halted = true;
    return true;
  }

  static is(value: unknown): value is Halt {
    // `#halted in` runs no code of the value; for a proxy it is false.
    return typeof value === 'object' && value !== null && #halted in value;
  }
}
Object.freeze(Halt.prototype);
Object.freeze(Halt);

/**
 * Makes a halt of writes that is not set. The composition root makes one
 * per process and hands it to every pipeline it builds.
 *
 * @returns The halt, not set.
 * @example
 * ```ts
 * const writeHalt = createWriteHalt();
 * ```
 */
export function createWriteHalt(): WriteHalt {
  return new Halt(key) as unknown as WriteHalt;
}

/**
 * Tells whether a value is a halt this module made.
 *
 * @param value - Any value, such as an option of a pipeline.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isWriteHalt({ __ecclium: 'WriteHalt' }); // false
 * ```
 */
export function isWriteHalt(value: unknown): value is WriteHalt {
  return Halt.is(value);
}

/**
 * Whether the writes of a halt are stopped. A value this module did not
 * make counts as stopped, so that nothing writes past a halt it cannot
 * read.
 *
 * @param halt - Any value, such as the halt of a write guard.
 * @returns Whether writes are stopped.
 * @example
 * ```ts
 * writesHalted(createWriteHalt()); // false
 * ```
 */
export function writesHalted(halt: unknown): boolean {
  return Halt.halted(key, halt) ?? true;
}

/**
 * Stops the writes of a halt until the process ends.
 *
 * @param halt - Any value, such as the halt of a write guard.
 * @returns Whether it was a halt of this module.
 * @example
 * ```ts
 * haltWrites(writeHalt); // true
 * ```
 */
export function haltWrites(halt: unknown): boolean {
  return Halt.halt(key, halt);
}
