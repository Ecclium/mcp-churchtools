/**
 * Answers as JSON what the SDK answers as a stream of one message (ADR
 * 0073). The SDK answers the leg of the 2025 era with server-sent events
 * even when the server asks for JSON, in a stream that ends after the one
 * message. A proxy or tunnel that does not pass streams on holds such an
 * answer back, so the place ingress hands the one message on as JSON, which
 * the protocol allows for a client that accepts both. A stream with more
 * than one message goes on unchanged.
 *
 * @packageDocumentation
 */

const isEventStream = (contentType: string | null): boolean =>
  (contentType ?? '').toLowerCase().startsWith('text/event-stream');

/**
 * The data of the only message of an ended stream of server-sent events,
 * when it is JSON, else `undefined`.
 *
 * @param text - The whole stream as text.
 * @returns The JSON of the one message, or `undefined`.
 * @example
 * ```ts
 * onlyMessageOf('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
 * // '{"jsonrpc":"2.0","id":1,"result":{}}'
 * ```
 */
export function onlyMessageOf(text: string): string | undefined {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  const [only] = data;
  if (data.length !== 1 || only === undefined) return undefined;
  try {
    JSON.parse(only);
    return only;
  } catch {
    return undefined;
  }
}

/**
 * Turns an answer of the SDK that is a stream of exactly one message into
 * the same answer as JSON, with the status of the stream. Any other answer
 * comes back as it is. A stream is read to its end, which is safe because
 * the server opens no stream that stays open: it refuses
 * `subscriptions/listen` before the handler, and `GET` ends with 405.
 *
 * @param response - What the handler of the SDK answered.
 * @returns The answer to send.
 * @example
 * ```ts
 * const answer = await asJsonWhenSingle(await handler.fetch(request));
 * ```
 */
export async function asJsonWhenSingle(response: Response): Promise<Response> {
  if (!isEventStream(response.headers.get('content-type'))) return response;
  const text = await response.text();
  const only = onlyMessageOf(text);
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.set(
    'content-type',
    only === undefined
      ? (response.headers.get('content-type') ?? 'text/event-stream')
      : 'application/json',
  );
  return new Response(only ?? text, { status: response.status, headers });
}
