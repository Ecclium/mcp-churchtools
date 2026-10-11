/**
 * Transport of the elicitation spike that watches the messages between
 * client and server, writes what they show to the record and passes every
 * message on unchanged (ADR 0053).
 *
 * Some answers come from the SDK on its own. It answers a forged
 * `requestState` with -32602 before any handler runs. For an older client
 * without elicitation, the handler of the spike asks once, and then the
 * shim of the SDK answers with an `isError` result instead of asking the
 * client. Only the messages show these answers, and only they show what the
 * client sent: its protocol version, its self-reported name and the
 * capabilities it declared. Reading
 * the capabilities of an older client here also spares the spike
 * `getClientCapabilities`, which the SDK marks as deprecated.
 *
 * @packageDocumentation
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';

import type { SpikeLog } from './log.js';

type JsonObject = Readonly<Record<string, unknown>>;
type Id = string | number;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const member = (value: unknown, key: string): unknown =>
  isObject(value) ? value[key] : undefined;

const keysOf = (value: unknown): string[] =>
  isObject(value) ? Object.keys(value) : [];

const idOf = (message: JSONRPCMessage): Id | undefined => {
  const id = member(message, 'id');
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

/** Capabilities whose members the spike records one level deep. */
const detailed = [
  'elicitation',
  'sampling',
  'roots',
  'extensions',
  'experimental',
];

/**
 * Names the capabilities a client declared, as `elicitation` and
 * `elicitation.form`, never their values.
 *
 * @param capabilities - The capabilities from `initialize` or from `_meta`.
 * @returns The names, empty if the value is not an object.
 * @example
 * ```ts
 * capabilityNames({ elicitation: { form: {} }, roots: {} });
 * // ['elicitation', 'elicitation.form', 'roots']
 * ```
 */
export function capabilityNames(capabilities: unknown): string[] {
  return keysOf(capabilities).flatMap((key) => [
    key,
    ...(detailed.includes(key)
      ? keysOf(member(capabilities, key)).map((inner) => `${key}.${inner}`)
      : []),
  ]);
}

/** What an older client said about itself in `initialize`. */
interface Hello {
  readonly protocolVersion: unknown;
  readonly clientName: unknown;
  readonly clientVersion: unknown;
  readonly capabilities: readonly string[];
}

/**
 * Wraps a transport so that the record shows every message of interest in
 * both directions. Messages pass unchanged and in the same order, and an
 * error while recording never reaches the protocol.
 *
 * @param inner - The transport that carries the messages, over stdio or in
 *   memory.
 * @param log - The record of the spike.
 * @param now - The current time in milliseconds since the epoch.
 * @returns A transport to hand to `serveStdio`.
 * @example
 * ```ts
 * const transport = observeTransport(new StdioServerTransport(), log, () => Date.now());
 * serveStdio(factory, { transport });
 * ```
 */
export function observeTransport(
  inner: Transport,
  log: SpikeLog,
  now: () => number,
): Transport {
  // Per connection, and gone with it: what an older client said in
  // initialize, the tools/call requests still waiting for an answer and
  // when each elicitation/create of the shim went out. The record numbers
  // calls and questions itself instead of naming the ids of the client,
  // which could carry any value.
  let hello: Hello | undefined;
  let calls = 0;
  let elicitations = 0;
  const openCalls = new Map<Id, number>();
  const sentElicitations = new Map<
    Id,
    { readonly number: number; readonly at: number }
  >();

  const inbound = (message: JSONRPCMessage): void => {
    const method = member(message, 'method');
    const params = member(message, 'params');
    const meta = member(params, '_meta');
    const id = idOf(message);
    if (method === 'initialize') {
      hello = {
        protocolVersion: member(params, 'protocolVersion'),
        clientName: member(member(params, 'clientInfo'), 'name'),
        clientVersion: member(member(params, 'clientInfo'), 'version'),
        capabilities: capabilityNames(member(params, 'capabilities')),
      };
      log.event('client_hello', hello);
    } else if (method === 'server/discover') {
      log.event('discover', {
        protocolVersion: member(meta, PROTOCOL_VERSION_META_KEY),
        clientName: member(member(meta, CLIENT_INFO_META_KEY), 'name'),
        clientVersion: member(member(meta, CLIENT_INFO_META_KEY), 'version'),
        capabilities: capabilityNames(
          member(meta, CLIENT_CAPABILITIES_META_KEY),
        ),
      });
    } else if (method === 'tools/call' && id !== undefined) {
      // A request of the 2026 era names its protocol version in _meta.
      const modern = member(meta, PROTOCOL_VERSION_META_KEY) !== undefined;
      const info = modern ? member(meta, CLIENT_INFO_META_KEY) : undefined;
      calls += 1;
      openCalls.set(id, calls);
      log.event('tool_call', {
        call: calls,
        era: modern ? 'modern' : 'legacy',
        protocolVersion: modern
          ? member(meta, PROTOCOL_VERSION_META_KEY)
          : hello?.protocolVersion,
        clientName: modern ? member(info, 'name') : hello?.clientName,
        clientVersion: modern ? member(info, 'version') : hello?.clientVersion,
        capabilities: modern
          ? capabilityNames(member(meta, CLIENT_CAPABILITIES_META_KEY))
          : (hello?.capabilities ?? []),
        metaKeys: keysOf(meta),
        requestState: typeof member(params, 'requestState') === 'string',
        inputResponses: keysOf(member(params, 'inputResponses')),
      });
    } else if (method === 'notifications/cancelled') {
      const requestId = member(params, 'requestId');
      log.event('cancel_received', {
        call:
          typeof requestId === 'string' || typeof requestId === 'number'
            ? openCalls.get(requestId)
            : undefined,
      });
    } else if (method === undefined && id !== undefined) {
      const sent = sentElicitations.get(id);
      if (sent !== undefined) {
        sentElicitations.delete(id);
        const result = member(message, 'result');
        log.event('elicitation_answered', {
          elicitation: sent.number,
          action: member(result, 'action'),
          contentKeys: keysOf(member(result, 'content')),
          errorCode: member(member(message, 'error'), 'code'),
          elapsedMs: now() - sent.at,
        });
      }
    }
  };

  const outbound = (message: JSONRPCMessage): void => {
    const method = member(message, 'method');
    const id = idOf(message);
    if (id === undefined) return;
    const call = openCalls.get(id);
    if (method === 'elicitation/create') {
      elicitations += 1;
      sentElicitations.set(id, { number: elicitations, at: now() });
      log.event('elicitation_sent', { elicitation: elicitations });
    } else if (method === undefined && call !== undefined) {
      openCalls.delete(id);
      const error = member(message, 'error');
      const result = member(message, 'result');
      log.event('response_sent', {
        call,
        outcome:
          error !== undefined
            ? 'error'
            : member(result, 'resultType') === 'input_required'
              ? 'input_required'
              : member(result, 'isError') === true
                ? 'is_error'
                : 'result',
        errorCode: member(error, 'code'),
      });
    }
  };

  // Recording must never change what the protocol does.
  const safely = (observe: () => void): void => {
    try {
      observe();
    } catch {
      log.event('server_error', { kind: 'other' });
    }
  };

  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => {
      safely(() => {
        outbound(message);
      });
      return inner.send(message, options);
    },
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
  };
  inner.onmessage = (message, extra) => {
    safely(() => {
      inbound(message);
    });
    outer.onmessage?.(message, extra);
  };
  inner.onerror = (error) => outer.onerror?.(error);
  inner.onclose = () => outer.onclose?.();
  return outer;
}
