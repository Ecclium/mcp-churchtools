/**
 * Checks of the body of a request over HTTP before the handler of the SDK
 * sees it (ADR 0073). The body is read once, with the reader of the SDK,
 * and handed to the SDK parsed, so that these checks and the SDK see the
 * same message: the reader drops a byte order mark at the start like the
 * SDK does, and a key that occurs twice counts the way JSON.parse counts
 * it, for both.
 *
 * @packageDocumentation
 */

/** The most bytes of a body the server reads, 1 MiB (ADR 0073). */
export const maxHttpBodyBytes = 1024 * 1024;

/**
 * The deepest a body may nest objects and arrays, 64 levels (ADR 0073). A
 * value that is no object and no array has depth 0.
 */
export const maxHttpBodyDepth = 64;

// The method the server refuses before the handler: it would open a stream
// that stays open, and the list of tools never changes while the process
// runs (ADR 0073).
const listenMethod = 'subscriptions/listen';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tells whether a parsed body nests deeper than {@link maxHttpBodyDepth}.
 * It walks the value with a list of its own, not by recursion, so that a
 * body as deep as 1 MiB allows ends with an answer and not with an
 * exhausted stack, and it stops at the first value too deep.
 *
 * @param value - A value JSON.parse returned.
 * @returns Whether some object or array lies deeper than the limit.
 * @example
 * ```ts
 * nestsTooDeep(JSON.parse('{"a":[1]}')); // false
 * ```
 */
export function nestsTooDeep(value: unknown): boolean {
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value: current, depth } = next;
    if (typeof current !== 'object' || current === null) continue;
    const inner = depth + 1;
    if (inner > maxHttpBodyDepth) return true;
    const children: readonly unknown[] = Array.isArray(current)
      ? current
      : Object.values(current);
    for (const child of children) {
      if (typeof child === 'object' && child !== null) {
        pending.push({ value: child, depth: inner });
      }
    }
  }
  return false;
}

/**
 * Tells whether a parsed body asks for `subscriptions/listen`, alone or as
 * a member of a list. A list is not a valid message of the protocol, but
 * the check must not let one pass that the SDK might take apart.
 *
 * @param value - A value JSON.parse returned.
 * @returns Whether a message of the body names the method.
 * @example
 * ```ts
 * asksToListen({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' }); // true
 * ```
 */
export function asksToListen(value: unknown): boolean {
  const messages: readonly unknown[] = Array.isArray(value) ? value : [value];
  return messages.some(
    (message) => isRecord(message) && message['method'] === listenMethod,
  );
}

/**
 * The ID of a single request in a parsed body, to answer a refusal with
 * it, or `null` when there is none of a form JSON-RPC allows.
 *
 * @param value - A value JSON.parse returned.
 * @returns A string or a number, or `null`.
 * @example
 * ```ts
 * requestIdOf({ jsonrpc: '2.0', id: 7, method: 'tools/list' }); // 7
 * ```
 */
export function requestIdOf(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}
