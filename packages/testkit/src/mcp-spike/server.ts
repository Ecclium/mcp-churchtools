/**
 * Server of the elicitation spike: the only module of testkit that
 * registers with the MCP SDK (ADR 0024, ADR 0053). It is never exported
 * through the entry point of testkit.
 *
 * The spike has one tool. Called the first time, it asks the person one
 * question through the client with `input_required`. Called again with an
 * answer, it records which button the person chose and ends. It never asks
 * twice, so a decline or a cancel cannot turn into a loop of questions.
 *
 * @packageDocumentation
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  type CallToolResult,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type McpServerFactory,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';

import type { SpikeLog } from './log.js';

/** Name of the one tool of the spike. */
export const spikeToolName = 'spike_rueckfrage';

/** Key of the one question in `inputRequests` and `inputResponses`. */
export const spikeQuestionKey = 'bestaetigung';

/** What the `requestState` carries from the question to the answer. */
export interface SpikeState {
  /** Random, from {@link SpikeServerOptions.newNonce}. */
  readonly nonce: string;
  /** When the question went out, in milliseconds since the epoch. */
  readonly mintedAt: number;
  /** Always 1: the spike asks only once. */
  readonly round: number;
}

/** What the spike needs from its start. */
export interface SpikeServerOptions {
  /** Signs and checks the `requestState`, see {@link createSpikeCodec}. */
  readonly codec: RequestStateCodec<SpikeState>;
  /** The record of the spike. */
  readonly log: SpikeLog;
  /** The current time in milliseconds since the epoch. */
  readonly now: () => number;
  /** A fresh random value of at least six hexadecimal digits per question. */
  readonly newNonce: () => string;
}

const colours = ['rot', 'gruen', 'blau'];

/**
 * The form of the question: flat, two fields, no personal data. Built anew
 * for every question, so that nothing can change a shared copy.
 *
 * @returns The schema for `requestedSchema`.
 */
function questionSchema(): ElicitRequestFormParams['requestedSchema'] {
  return {
    type: 'object',
    properties: {
      bestaetigt: {
        type: 'boolean',
        title: 'Bestätigt',
        description: 'Ja, wenn Sie die Testfrage bestätigen.',
      },
      farbe: {
        type: 'string',
        title: 'Farbe',
        description: 'Eine beliebige Farbe, nur zur Probe.',
        enum: [...colours],
      },
    },
    required: ['bestaetigt'],
  };
}

// The reasons the codec of the SDK gives for a rejected requestState. The
// SDK hands them to onerror inside a sentence; only the word goes on.
const rejection = /^requestState verification rejected \S+: (\w+)$/;
const reasons = ['malformed', 'mac', 'expired', 'bind'];

/**
 * Creates the codec for the `requestState` of the spike: signed with
 * HMAC-SHA256, valid for 600 seconds and bound to the method of the request
 * (ADR 0053). The specification asks to bind it to the principal as well.
 * Over stdio the spike has none; one key per process stands for it, so a
 * `requestState` never outlives the process.
 *
 * @param key - At least 32 random bytes, new for every process.
 * @returns The codec.
 * @throws {RangeError} If the key is shorter than 32 bytes.
 * @example
 * ```ts
 * const codec = createSpikeCodec(randomBytes(32));
 * ```
 */
export function createSpikeCodec(
  key: Uint8Array,
): RequestStateCodec<SpikeState> {
  return createRequestStateCodec<SpikeState>({
    key,
    ttlSeconds: 600,
    bind: (ctx) => ctx.mcpReq.method,
  });
}

/**
 * The short code that the question shows and the record names, so that
 * the person can tell the question from the approval dialog of the tool
 * and match it to its line in the record.
 *
 * @param nonce - The nonce of the question.
 * @returns Its first six characters in upper case.
 * @example
 * ```ts
 * shortCode('a1b2c3d4e5f60718'); // 'A1B2C3'
 * ```
 */
export function shortCode(nonce: string): string {
  return nonce.slice(0, 6).toUpperCase();
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tells whether a client declared elicitation in form mode. An empty
 * object means form mode (specification 2026-07-28, client/elicitation).
 *
 * @param capabilities - The capabilities the request declares.
 * @returns Whether the spike may ask in form mode.
 * @example
 * ```ts
 * declaresFormElicitation({ elicitation: {} }); // true
 * declaresFormElicitation({ elicitation: { url: {} } }); // false
 * ```
 */
export function declaresFormElicitation(capabilities: unknown): boolean {
  const elicitation = isObject(capabilities)
    ? capabilities['elicitation']
    : undefined;
  return (
    isObject(elicitation) &&
    (Object.keys(elicitation).length === 0 || isObject(elicitation['form']))
  );
}

/**
 * Checks accepted content by hand against the form of the question. The
 * shim of the SDK does not check it, and the spike loads no schema library.
 *
 * @param content - The content of an accepted answer.
 * @returns Whether it fits the form.
 * @example
 * ```ts
 * isValidAnswer({ bestaetigt: true, farbe: 'blau' }); // true
 * isValidAnswer({ bestaetigt: 'ja' }); // false
 * ```
 */
export function isValidAnswer(content: unknown): boolean {
  if (!isObject(content)) return false;
  const known = Object.keys(content).every(
    (key) => key === 'bestaetigt' || key === 'farbe',
  );
  const farbe = content['farbe'];
  return (
    known &&
    typeof content['bestaetigt'] === 'boolean' &&
    (farbe === undefined ||
      (typeof farbe === 'string' && colours.includes(farbe)))
  );
}

const text = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
});

async function ask(
  ctx: ServerContext,
  era: 'legacy' | 'modern',
  { codec, log, now, newNonce }: SpikeServerOptions,
): Promise<CallToolResult | InputRequiredResult> {
  const state = ctx.mcpReq.requestState<SpikeState>();
  if (state === undefined) {
    // Ask only for what the client declared (specification, requirement 7).
    // An older client is left to the shim of the SDK, which answers with
    // isError when it declared no elicitation.
    const envelope = ctx.mcpReq.envelope as
      Readonly<Record<string, unknown>> | undefined;
    if (
      era === 'modern' &&
      !declaresFormElicitation(envelope?.[CLIENT_CAPABILITIES_META_KEY])
    ) {
      log.event('capability_absent', { era });
      return text(
        'Elicitation spike: the client declared no form elicitation, so the spike did not ask.',
      );
    }
    const nonce = newNonce();
    const requestState = await codec.mint(
      { nonce, mintedAt: now(), round: 1 },
      ctx,
    );
    log.event('input_required_issued', {
      nonce,
      code: shortCode(nonce),
      round: 1,
    });
    return inputRequired({
      inputRequests: {
        [spikeQuestionKey]: inputRequired.elicit({
          message: `Ecclium-Spike ${shortCode(nonce)}: Dies ist eine Testfrage. Antworten Sie so, wie es die Anleitung für diesen Lauf vorsieht. Ihre Eingaben werden nicht gespeichert.`,
          requestedSchema: questionSchema(),
        }),
      },
      requestState,
    });
  }
  const answer = inputResponse(ctx.mcpReq.inputResponses, spikeQuestionKey);
  const action = answer.kind === 'elicit' ? answer.action : answer.kind;
  const content = answer.kind === 'elicit' ? answer.content : undefined;
  log.event('retry_received', {
    nonce: state.nonce,
    round: state.round,
    action,
    contentKeys: Object.keys(content ?? {}),
    ...(action === 'accept' ? { valid: isValidAnswer(content) } : {}),
    elapsedMs: now() - state.mintedAt,
  });
  return text(
    `Elicitation spike ${shortCode(state.nonce)}: answer "${action}" received. The spike does not ask again.`,
  );
}

/**
 * Creates the factory that `serveStdio` calls once per connection, twice
 * when a client probes with `server/discover` and falls back to
 * `initialize`. It is cheap and has no side effect beyond the record, and
 * the instance it builds holds no data of a request (ADR 0051, ADR 0053).
 *
 * @param options - Codec, record, clock and source of nonces.
 * @returns The factory.
 * @example
 * ```ts
 * const factory = createSpikeServer({ codec, log, now: () => Date.now(), newNonce });
 * serveStdio(factory, { transport });
 * ```
 */
export function createSpikeServer(
  options: SpikeServerOptions,
): McpServerFactory {
  return (context) => {
    options.log.event('instance_created', { era: context.era });
    const mcp = new McpServer(
      { name: 'ecclium-elicitation-spike', version: '0.0.0' },
      {
        requestState: {
          verify: (state, ctx) => options.codec.verify(state, ctx),
        },
        // Set on purpose rather than left to the defaults: at most eight
        // rounds of the shim for older clients, ten minutes for a person
        // to answer, and the shim itself switched on.
        inputRequired: {
          maxRounds: 8,
          roundTimeoutMs: 600_000,
          legacyShim: true,
        },
      },
    );
    // The SDK reports a rejected requestState only here, never on the wire
    // and not to serveStdio. Only the reason word reaches the record.
    mcp.server.onerror = (error) => {
      const reason = rejection.exec(error.message)?.[1];
      if (reason === undefined) {
        options.log.event('server_error', { kind: 'other' });
      } else {
        options.log.event('request_rejected', {
          reason: reasons.includes(reason) ? reason : 'other',
        });
      }
    };
    mcp.registerTool(
      spikeToolName,
      {
        title: 'Elicitation spike',
        description:
          'Asks the person one test question through the client and reports only which choice they made. Call it only when the person running the elicitation spike asks for it.',
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (ctx) => ask(ctx, context.era, options),
    );
    return mcp;
  };
}
