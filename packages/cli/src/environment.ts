/**
 * Takes over the environment of the process for the command line
 * (ADR 0055). The loader gets a frozen copy, and every variable that holds
 * a secret leaves the environment itself, so that child processes and
 * other code in the process no longer see it. The module imports nothing
 * of the packages, so a test can run it from source in a child process.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

const invalidEnvironment = 'The environment cannot be taken over.';

// Capitals in ASCII only, as the loader compares names: toUpperCase would
// turn a dotless i or a long s into I or S.
const asciiUpper = (text: string): string => {
  let upper = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    upper += String.fromCharCode(
      code >= 0x61 && code <= 0x7a ? code - 0x20 : code,
    );
  }
  return upper;
};

/**
 * Copies the environment and removes the variables that hold a secret
 * from it, in every spelling of their names. Only own string values are
 * copied, which is all `process.env` holds. A getter is refused unread,
 * because it would run code of the caller and could give another value
 * on every read, and so is a value that is no string.
 *
 * @param environment - The environment of the process, which loses the
 *   variables that hold a secret.
 * @param secretNames - The names of those variables, in capitals.
 * @returns The copy for the loader, frozen and without a prototype.
 * @throws {TypeError} When the environment is no object or a proxy, holds
 *   a getter or a value that is no string, or the names are no list.
 * @example
 * ```ts
 * const copy = takeEnvironment(environment, [tokenVariableName]);
 * ```
 */
export function takeEnvironment(
  environment: Record<string, string | undefined>,
  secretNames: readonly string[],
): Readonly<Record<string, string>> {
  // Checked as unknown: the caller passes the environment of the process.
  const given: unknown = environment;
  if (
    typeof given !== 'object' ||
    given === null ||
    isProxy(given) ||
    isProxy(secretNames) ||
    !Array.isArray(secretNames)
  ) {
    throw new TypeError(invalidEnvironment);
  }
  // All values are read before the first variable is removed, so that a
  // refusal leaves the environment as it was.
  const copy: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const keys = Object.keys(environment);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) throw new TypeError(invalidEnvironment);
    const value: unknown = descriptor.value;
    if (typeof value === 'string') copy[key] = value;
    else if (value !== undefined) throw new TypeError(invalidEnvironment);
  }
  for (const key of keys) {
    // Deleting a key of process.env removes the variable from the
    // environment that child processes inherit.
    if (secretNames.includes(asciiUpper(key))) {
      Reflect.deleteProperty(environment, key);
    }
  }
  return Object.freeze(copy);
}
