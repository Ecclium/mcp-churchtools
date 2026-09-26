/**
 * The last check before anything leaves a probe.
 *
 * Two independent checks run over every key and every value of the output:
 *
 * 1. Allow list: each word must be known. Known are the fixed words of the
 *    probes, keys taken from the instance under a policy (declared in the
 *    specification, or lower-case right names), and the ChurchTools version
 *    as major and minor number.
 * 2. Block list: no key taken from the instance may contain anything that
 *    came from the instance or the local machine as a whole word: host and
 *    host parts, token, the values of the probe variables, user name and
 *    home folder, the state file, header values and every string and number
 *    of the responses. Comparison ignores case and also looks for the
 *    URL-encoded form.
 *
 * If either check fails, the probe prints nothing but the positions of the
 * findings, as JSON pointers whose unknown parts are replaced by numbers.
 *
 * @packageDocumentation
 */

/** A JSON value as the probes produce it. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

const versionPattern = /^\d+\.\d+$/;

/**
 * Collects what may and what must not appear in the output of a probe.
 *
 * @example
 * ```ts
 * const guard = new Guard();
 * guard.allowFixed('status', 'vorhanden');
 * guard.block('Max Mustermann');
 * guard.check({ status: 'vorhanden' }); // []
 * ```
 */
export class Guard {
  readonly #fixed = new Set<string>();
  readonly #checked = new Set<string>();
  #version: string | undefined;
  readonly #blockedText = new Set<string>();
  readonly #blockedNumbers = new Set<string>();

  /**
   * Allows fixed words of the probes, such as keys, type names and classes.
   *
   * These words are written in the probes themselves, so they are exempt
   * from the block list: a response that happens to contain the word
   * `status` must not suppress the output key `status`.
   *
   * @param words - Words and numbers to allow.
   */
  allowFixed(...words: readonly (string | number)[]): void {
    for (const word of words) {
      this.#fixed.add(String(word));
    }
  }

  /**
   * Allows a key taken from the instance, such as a key the specification
   * declares or the name of a right.
   *
   * Such keys come from outside the probes, so they are also checked
   * against the block list.
   *
   * @param key - Key taken from the instance.
   */
  allowChecked(key: string): void {
    this.#checked.add(key);
  }

  /**
   * Allows the ChurchTools version, the one value from the instance that
   * may appear in the output.
   *
   * @param version - Major and minor number, such as `3.136`.
   * @throws {Error} If the version has another form.
   */
  allowVersion(version: string): void {
    if (!versionPattern.test(version)) {
      throw new Error('INTERN');
    }
    this.#version = version;
  }

  /**
   * Adds one value to the block list.
   *
   * Text shorter than three characters is not added, because it would match
   * almost every word. Such text can still not reach the output, since the
   * allow list does not contain it.
   *
   * @param value - Value from the instance or the local machine.
   */
  block(value: string | number): void {
    const text = String(value).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      this.#blockedNumbers.add(text.replace(/^-/, ''));
    }
    if (text.length >= 3) {
      this.#blockedText.add(text.toLowerCase());
      this.#blockedText.add(encodeURIComponent(text).toLowerCase());
    }
  }

  /**
   * Adds every string and number inside a JSON value to the block list.
   *
   * Keys are not added: most keys of a response are names the
   * specification declares, and the output shows them on purpose. A key
   * that carries data, such as a group ID, never reaches the output,
   * because it is replaced by `<key#n>` and the allow list does not
   * contain it.
   *
   * @param value - Parsed response or other structured data.
   */
  blockAll(value: unknown): void {
    if (typeof value === 'string' || typeof value === 'number') {
      this.block(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        this.blockAll(item);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) {
        this.blockAll(item);
      }
    }
  }

  /**
   * Checks an output against both lists.
   *
   * @param output - The complete output of a probe.
   * @returns JSON pointers of every finding, empty if the output may be shown.
   */
  check(output: Json): string[] {
    const findings = new Set<string>();
    const visit = (value: Json, pointer: string): void => {
      if (isList(value)) {
        value.forEach((item, index) => {
          visit(item, `${pointer}/${String(index)}`);
        });
        return;
      }
      if (typeof value === 'object' && value !== null) {
        Object.entries(value).forEach(([key, item], index) => {
          const shown = this.#fixed.has(key) ? key : `#${String(index)}`;
          if (!this.#isAllowed(key)) {
            findings.add(`${pointer}/${shown}`);
          }
          visit(item, `${pointer}/${shown}`);
        });
        return;
      }
      if (typeof value === 'string' || typeof value === 'number') {
        if (!this.#isAllowed(String(value))) {
          findings.add(pointer === '' ? '/' : pointer);
        }
      }
    };
    visit(output, '');
    return [...findings];
  }

  #isAllowed(word: string): boolean {
    if (this.#fixed.has(word)) {
      return true;
    }
    if (word === this.#version) {
      return true;
    }
    return this.#checked.has(word) && !this.#isBlocked(word);
  }

  #isBlocked(word: string): boolean {
    const lower = word.toLowerCase();
    for (const blocked of this.#blockedText) {
      if (containsWord(lower, blocked)) {
        return true;
      }
    }
    for (const run of word.match(/\d+(?:\.\d+)*/g) ?? []) {
      if (this.#blockedNumbers.has(run)) {
        return true;
      }
    }
    return false;
  }
}

// Array.isArray widens a read-only array to any[]; this keeps the type.
function isList(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}

const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * Tells whether a text contains another text as a whole word.
 *
 * A blocked value counts only where it is not part of a longer word, so a
 * response value such as `wiki` does not block the key `wikiCategory` of
 * the specification. Letters with diacritics count as word characters.
 *
 * @param text - Text to search, in lower case.
 * @param part - Text to find, in lower case.
 * @returns Whether `part` occurs in `text` between word boundaries.
 */
export function containsWord(text: string, part: string): boolean {
  let index = text.indexOf(part);
  while (index !== -1) {
    const before = text.charAt(index - 1);
    const after = text.charAt(index + part.length);
    const startsWord =
      before === '' ||
      !wordCharacter.test(before) ||
      !wordCharacter.test(part.charAt(0));
    const endsWord =
      after === '' ||
      !wordCharacter.test(after) ||
      !wordCharacter.test(part.charAt(part.length - 1));
    if (startsWord && endsWord) {
      return true;
    }
    index = text.indexOf(part, index + 1);
  }
  return false;
}
