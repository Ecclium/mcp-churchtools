/**
 * A check of JSON text before it is parsed (ADR 0057). `JSON.parse` has no
 * limit for depth or elements, so an answer of ChurchTools could make it
 * build a huge or deeply nested value. The check walks the text once,
 * without a regular expression, and counts outside of strings only.
 *
 * @packageDocumentation
 */

/** The limits of the check. */
export interface ShapeLimits {
  /** The most levels of objects and arrays. */
  readonly maxDepth: number;
  /** The most opening brackets and commas outside of strings. */
  readonly maxElements: number;
}

const quote = 0x22;
const backslash = 0x5c;
const openObject = 0x7b;
const closeObject = 0x7d;
const openArray = 0x5b;
const closeArray = 0x5d;
const comma = 0x2c;

/**
 * Tells whether JSON text stays within the limits. It does not check that
 * the text is valid JSON; `JSON.parse` does that afterwards.
 *
 * @param text - The decoded body.
 * @param limits - Depth and elements.
 * @returns Whether the text stays within both limits.
 * @example
 * ```ts
 * fitsShape('{"a":[1,2]}', { maxDepth: 16, maxElements: 100 }); // true
 * ```
 */
export function fitsShape(text: string, limits: ShapeLimits): boolean {
  let depth = 0;
  let elements = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === backslash) escaped = true;
      else if (code === quote) inString = false;
      continue;
    }
    if (code === quote) {
      inString = true;
    } else if (code === openObject || code === openArray) {
      depth += 1;
      elements += 1;
      if (depth > limits.maxDepth || elements > limits.maxElements) {
        return false;
      }
    } else if (code === closeObject || code === closeArray) {
      depth -= 1;
    } else if (code === comma) {
      elements += 1;
      if (elements > limits.maxElements) return false;
    }
  }
  return true;
}
