/**
 * The client side of a write, as the smoke test for writing speaks it.
 *
 * A write tool of Ecclium only plans; the core asks before it writes
 * (ADR 0029). How the question comes depends on the era of the protocol
 * and on what the client declared (ADR 0053):
 *
 * - 2026 with elicitation: the call ends with `input_required`, one
 *   question under the key `bestaetigung` and a signed `requestState`. The
 *   answer goes out as a second `tools/call` with the same name and
 *   arguments, `inputResponses` and that `requestState`.
 * - 2025 with elicitation: the server sends `elicitation/create` as a
 *   request to the client while the call waits, and the session answers it.
 * - Without elicitation: the write tool gives a token and a summary for
 *   `ct_write_confirm`, the echo, or the write waits in the queue.
 *
 * The smoke test answers as a person would, with fixed answers, and never
 * prints what a question says: its summary and diff hold text that is
 * about to reach ChurchTools.
 *
 * @packageDocumentation
 */
import { isRecord } from '../smoke/answers.mts';
import type {
  Answer,
  ServerRequestHandler,
  Session,
} from '../smoke/session.mts';

/** The era of the protocol a process speaks. */
export type Era = '2026' | '2025';

/** How the smoke test presents itself to one process. */
export interface ClientKind {
  readonly era: Era;
  /** Whether the client declares elicitation in form mode. */
  readonly elicitation: boolean;
}

/**
 * What the person answers to a question before a write: yes, no in the
 * form, a decline of the form, or a cancel.
 */
export type Reply = 'ja' | 'nein' | 'ablehnen' | 'abbrechen';

// The key of the one question of a write and the one field of its form,
// as the core asks (ADR 0029).
const questionKey = 'bestaetigung';
const confirmField = 'bestaetigen';

const clientInfo = { name: 'ecclium-smoke-write', version: '1' };

/**
 * The metadata a client of the 2026 era sends with every request.
 *
 * @param elicitation - Whether the client declares elicitation in form mode.
 * @returns The value of `_meta`.
 */
export function metaOf(elicitation: boolean): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': elicitation
      ? { elicitation: { form: {} } }
      : {},
  };
}

/**
 * The params of a request in the era of the client: in 2026 with the
 * metadata of the client, in 2025 as they are.
 *
 * @param client - Era and capabilities.
 * @param body - The params without metadata.
 * @returns The params to send.
 */
export function paramsFor(
  client: ClientKind,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return client.era === '2026'
    ? { ...body, _meta: metaOf(client.elicitation) }
    : body;
}

/**
 * Opens the connection: `server/discover` in 2026, `initialize` and
 * `notifications/initialized` in 2025, with elicitation declared or not.
 *
 * @param session - The started process.
 * @param client - Era and capabilities.
 * @returns Whether the server answered with a result.
 */
export async function openConnection(
  session: Session,
  client: ClientKind,
): Promise<boolean> {
  const opened =
    client.era === '2026'
      ? await session.request('server/discover', paramsFor(client, {}))
      : await session.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: client.elicitation ? { elicitation: {} } : {},
          clientInfo,
        });
  const started = opened.kind === 'result' && isRecord(opened.result);
  if (started && client.era === '2025') {
    session.notify('notifications/initialized');
  }
  return started;
}

/**
 * The content of an answer to a question, after a check of the form: it
 * must ask for exactly one field, `bestaetigen`, a yes or no.
 *
 * @param params - The params of the question, as `elicitation/create` carries them.
 * @param reply - What the person answers.
 * @returns The answer, or `undefined` if the question has another form.
 */
export function answerTo(
  params: unknown,
  reply: Reply,
): Record<string, unknown> | undefined {
  const schema = isRecord(params) ? params['requestedSchema'] : undefined;
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  const field = isRecord(properties) ? properties[confirmField] : undefined;
  const required = isRecord(schema) ? schema['required'] : undefined;
  if (
    !isRecord(field) ||
    field['type'] !== 'boolean' ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== confirmField ||
    (isRecord(params) &&
      params['mode'] !== undefined &&
      params['mode'] !== 'form')
  ) {
    return undefined;
  }
  switch (reply) {
    case 'ja':
      return { action: 'accept', content: { [confirmField]: true } };
    case 'nein':
      return { action: 'accept', content: { [confirmField]: false } };
    case 'ablehnen':
      return { action: 'decline' };
    case 'abbrechen':
      return { action: 'cancel' };
  }
}

/**
 * The text a question shows, to keep it out of every output.
 *
 * @param params - The params of the question.
 * @returns Its message, or `undefined` without one.
 */
export const messageOf = (params: unknown): string | undefined => {
  const message = isRecord(params) ? params['message'] : undefined;
  return typeof message === 'string' ? message : undefined;
};

/** A question of the 2026 era that waits for its second round. */
export interface Pending {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The signed state the server gave; the client sends it back as is. */
  readonly requestState: string;
  /** The params of the question, `message` and `requestedSchema`. */
  readonly params: unknown;
}

/**
 * Reads the question of an answer of the 2026 era, if it is one.
 *
 * @param answer - The answer to `tools/call`.
 * @param name - The tool that was called.
 * @param args - Its arguments, for the second round.
 * @returns The question, or `undefined` if the answer is no question of the expected form.
 */
export function pendingOf(
  answer: Answer,
  name: string,
  args: Record<string, unknown>,
): Pending | undefined {
  if (answer.kind !== 'result' || !isRecord(answer.result)) return undefined;
  const { result } = answer;
  const requests = result['inputRequests'];
  const question = isRecord(requests) ? requests[questionKey] : undefined;
  const state = result['requestState'];
  if (
    result['resultType'] !== 'input_required' ||
    !isRecord(requests) ||
    Object.keys(requests).length !== 1 ||
    !isRecord(question) ||
    question['method'] !== 'elicitation/create' ||
    typeof state !== 'string' ||
    state === ''
  ) {
    return undefined;
  }
  return { name, args, requestState: state, params: question['params'] };
}

/**
 * Sends the second round of a question of the 2026 era.
 *
 * @param session - The process.
 * @param pending - The question and its state.
 * @param reply - What the person answers.
 * @returns The answer of the server, or `undefined` if the question had another form and nothing was sent.
 */
export async function answerPending(
  session: Session,
  pending: Pending,
  reply: Reply,
): Promise<Answer | undefined> {
  const content = answerTo(pending.params, reply);
  if (content === undefined) return undefined;
  return session.request(
    'tools/call',
    paramsFor(
      { era: '2026', elicitation: true },
      {
        name: pending.name,
        arguments: pending.args,
        inputResponses: { [questionKey]: content },
        requestState: pending.requestState,
      },
    ),
  );
}

/** Answers the questions of the 2025 era, one prepared reply at a time. */
export interface LegacyAnswers {
  /** For {@link startServer}: answers `elicitation/create`. */
  readonly handler: ServerRequestHandler;
  /** Prepares the reply to the next question. */
  readonly prepare: (reply: Reply) => void;
  /**
   * The questions asked since the last {@link LegacyAnswers.prepare}, and
   * whether each had the expected form.
   */
  readonly asked: () => readonly { readonly fits: boolean }[];
}

/**
 * Makes the answers of a client of the 2025 era with elicitation. A
 * question without a prepared reply, or of another form, gets the error of
 * an unknown method, and the call then writes nothing.
 *
 * @param see - Takes the text of each question onto the block lists.
 * @returns The handler and its controls.
 */
export function legacyAnswers(see: (text: string) => void): LegacyAnswers {
  let prepared: Reply | undefined;
  let asked: { readonly fits: boolean }[] = [];
  return {
    handler: (method, params) => {
      if (method !== 'elicitation/create') return undefined;
      const message = messageOf(params);
      if (message !== undefined) see(message);
      const reply = prepared;
      prepared = undefined;
      const content = reply === undefined ? undefined : answerTo(params, reply);
      asked.push({ fits: content !== undefined });
      return content;
    },
    prepare: (reply) => {
      prepared = reply;
      asked = [];
    },
    asked: () => asked,
  };
}
