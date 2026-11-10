/**
 * The writes of one run of a routine (ADR 0032): how often the run wrote
 * under each entry of the policy, for its limit per run.
 *
 * Where it stands in a run: the composition root makes one at the start
 * of a run and hands it to every write of the run, never to the engine.
 * The write guard reads it when it plans a write of the run and adds the
 * write right before it sends, as it does with the counter of the day.
 *
 * Why in memory and not in the store of quotas: a run is one unit in one
 * process, and the lock per routine that comes with the runner will keep
 * two runs of a routine apart. A
 * counter per run in the store would need a kind of key of its own in the
 * interface for plugins and stay there until the end of the day. A run
 * that ends loses its counter, which is what its limit means.
 *
 * Like a proof, the counter is a class with a private field behind a key
 * that only this module holds, so that no tool and no engine makes one or
 * changes its count, and a copy counts as none. It lives as long as its
 * run, which holds it; it is no state of the module.
 *
 * @packageDocumentation
 */

/** The writes of one run, as the write guard takes them. */
export interface RunWrites {
  readonly __ecclium: 'RunWrites';
}

// The key of this module; no code outside it can get it.
const key: unique symbol = Symbol('ecclium.run-writes');

class Writes {
  readonly #counts = new Map<string, number>();

  constructor(given: symbol) {
    if (given !== key) throw new TypeError('Only the core counts a run.');
    Object.freeze(this);
  }

  /**
   * The count of a counter of a value of this module.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @param counter - The counter, such as the key of an entry.
   * @returns The count, or undefined for a value that is none.
   */
  static count(
    given: symbol,
    value: unknown,
    counter: string,
  ): number | undefined {
    if (given !== key || !Writes.is(value)) return undefined;
    return value.#counts.get(counter) ?? 0;
  }

  /**
   * Adds one write to a counter of a value of this module.
   *
   * @param given - The key of this module.
   * @param value - Any value.
   * @param counter - The counter.
   * @returns The count with the write, or undefined for a value that is
   *   none.
   */
  static add(
    given: symbol,
    value: unknown,
    counter: string,
  ): number | undefined {
    if (given !== key || !Writes.is(value)) return undefined;
    const count = (value.#counts.get(counter) ?? 0) + 1;
    value.#counts.set(counter, count);
    return count;
  }

  static is(value: unknown): value is Writes {
    // `#counts in` runs no code of the value; for a proxy it is false.
    return typeof value === 'object' && value !== null && #counts in value;
  }
}
Object.freeze(Writes.prototype);
Object.freeze(Writes);

/**
 * Makes the counter of the writes of a new run. Only the composition root
 * calls it, once per run.
 *
 * @returns The counter, with nothing counted.
 * @example
 * ```ts
 * const writes = createRunWrites();
 * ```
 */
export function createRunWrites(): RunWrites {
  return new Writes(key) as unknown as RunWrites;
}

/**
 * Tells whether a value is a counter of the writes of a run this module
 * made, without counting.
 *
 * @param value - Any value, such as the counter a request named.
 * @returns Whether it is one.
 * @example
 * ```ts
 * isRunWrites({ __ecclium: 'RunWrites' }); // false
 * ```
 */
export function isRunWrites(value: unknown): value is RunWrites {
  return Writes.is(value);
}

/**
 * How often a run wrote under a counter.
 *
 * @param writes - Any value, such as the counter a request named.
 * @param counter - The counter, such as the key of an entry of the policy.
 * @returns The count, or undefined for a value this module did not make.
 * @example
 * ```ts
 * runWriteCount(writes, 'write:ct_wiki_page_append_section:wiki_category:12'); // 0
 * ```
 */
export function runWriteCount(
  writes: unknown,
  counter: string,
): number | undefined {
  return Writes.count(key, writes, counter);
}

/**
 * Adds a write of a run to a counter.
 *
 * @param writes - Any value, such as the counter a request named.
 * @param counter - The counter.
 * @returns The count with the write, or undefined for a value this module
 *   did not make.
 * @example
 * ```ts
 * addRunWrite(writes, 'write:ct_wiki_page_append_section:wiki_category:12'); // 1
 * ```
 */
export function addRunWrite(
  writes: unknown,
  counter: string,
): number | undefined {
  return Writes.add(key, writes, counter);
}
