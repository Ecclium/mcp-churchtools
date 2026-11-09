/**
 * The adapter of the core for chat interfaces in the style of OpenAI
 * (ADR 0033), which many vendors offer, also some that host an open model
 * in Switzerland or the EEA.
 *
 * Where it stands in a run: in the step of the model, behind the guard of
 * core, which has checked every part with data and turned it into text.
 * The adapter only builds the request, sends it over the transport the
 * composition root built for its provider and reads the answer.
 *
 * Why it looks as it does: the model gets data and an output schema, never
 * a tool. A vendor that follows a JSON Schema gets it as `response_format`
 * of the type `json_schema`, and an answer that does not fit ends the call.
 * A vendor without structured output is asked for one JSON object in the
 * text and gets exactly one second attempt, with a fixed sentence for the
 * reason, never with the text of the first answer, so that an injection
 * in that answer does not reach the second prompt. No text of the vendor
 * leaves the adapter: every failure is a code with a fixed sentence.
 *
 * Fields of the request: `model`, `messages` with one message of the role
 * `system` and one of the role `user`, `max_tokens` and, with structured
 * output, `response_format`. Fields of the answer: `choices[0].message`
 * with `content` and `refusal`, `choices[0].finish_reason` and `usage`
 * with `prompt_tokens` and `completion_tokens`. Unknown fields are
 * dropped.
 *
 * @packageDocumentation
 */
import {
  type ModelTransport,
  parseModelJson,
  readModelAnswer,
} from '@ecclium/mcp-churchtools-core';
import {
  EccliumError,
  type ErrorCode,
  isEccliumError,
  type ModelOutputSpec,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ProviderInfo,
  type TokenUsage,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/** What the adapter is built from. */
export interface OpenAiCompatibleOptions {
  /** Vendor, model, country, host and basis, from the configuration. */
  readonly info: ProviderInfo;
  /** Whether the vendor follows a JSON Schema for the answer. */
  readonly nativeStructuredOutput: boolean;
  /** The transport to the endpoint, built by the composition root. */
  readonly transport: ModelTransport;
}

/** The limits of the adapter, frozen. */
export const openAiCompatibleLimits: {
  readonly maxResponseBytes: number;
} = Object.freeze({
  /** The most bytes of an answer, the limit of the transport to a model. */
  maxResponseBytes: 1024 * 1024,
});

/** Why an answer did not count, and the sentence for the second attempt. */
type Rejection = 'json' | 'schema' | 'length';

// The sentences of a second attempt, fixed: the reason, never the answer.
const retrySentences: Readonly<Record<Rejection, string>> = Object.freeze({
  json: 'Your last answer was not one JSON object. Answer again with exactly one JSON object and nothing else.',
  schema:
    'Your last answer did not match the JSON Schema. Answer again with exactly one JSON object that matches it.',
  length:
    'Your last answer was cut off. Answer again with exactly one shorter JSON object.',
});

// What the model is asked when the vendor does not follow a schema.
const jsonInstruction = (output: ModelOutputSpec<unknown>): string =>
  `Answer with exactly one JSON object and nothing else, without Markdown. It must match this JSON Schema:\n${JSON.stringify(output.jsonSchema)}`;

// The answer of the endpoint as far as the adapter reads it. Unknown
// fields are dropped, as the client of ChurchTools drops them.
const answerSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.int().min(0),
      completion_tokens: z.int().min(0),
    })
    .optional(),
});

const fail = (code: ErrorCode, message: string): EccliumError =>
  new EccliumError(code, message);

/** What one attempt gave: the value, or why it did not count. */
type Attempt<T> =
  | { readonly ok: true; readonly value: T; readonly usage?: TokenUsage }
  | {
      readonly ok: false;
      readonly rejection: Rejection;
      readonly usage?: TokenUsage;
    };

/**
 * Builds the adapter to one model behind a chat interface in the style of
 * OpenAI. The composition root wraps it in the guard of core before the
 * engine gets it.
 *
 * @param options - Information, kind of output and transport.
 * @returns The provider, frozen.
 * @example
 * ```ts
 * const model = guardModelProvider(
 *   createOpenAiCompatibleProvider({
 *     info: provider.info,
 *     nativeStructuredOutput: provider.structuredOutput,
 *     transport,
 *   }),
 * );
 * ```
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): ModelProvider {
  const { info, nativeStructuredOutput: native, transport } = options;
  const encoder = new TextEncoder();

  // One request to the endpoint: the system text, with the request for
  // JSON when the vendor follows no schema, and the parts as one text of
  // the user, with the sentence of a second attempt at its end. One message
  // of each role, because the templates of some open models refuse two
  // messages of the user in a row.
  const send = async (
    request: ModelRequest<unknown>,
    rejection: Rejection | undefined,
    signal: AbortSignal,
  ): Promise<z.output<typeof answerSchema>> => {
    const system = native
      ? request.system
      : `${request.system}\n\n${jsonInstruction(request.output)}`;
    const texts = [
      ...request.parts.map((part) => part.text),
      ...(rejection === undefined ? [] : [retrySentences[rejection]]),
    ];
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: texts.join('\n\n') },
    ];
    const body = {
      model: info.model,
      messages,
      max_tokens: request.maxOutputTokens,
      ...(native
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.output.name,
                strict: true,
                schema: request.output.jsonSchema,
              },
            },
          }
        : {}),
    };
    let response;
    try {
      response = await transport.post({
        body: encoder.encode(JSON.stringify(body)),
        maxResponseBytes: openAiCompatibleLimits.maxResponseBytes,
        signal,
      });
    } catch (error) {
      throw fail(
        isEccliumError(error) ? error.code : 'network',
        'The endpoint of the model did not answer.',
      );
    }
    const read = readModelAnswer(response);
    if (!read.ok) {
      throw fail(read.code, 'The endpoint of the model refused the call.');
    }
    const parsed = answerSchema.safeParse(read.root);
    if (!parsed.success) {
      throw fail('upstream', 'The answer of the endpoint has an unknown form.');
    }
    return parsed.data;
  };

  // One attempt: the request, then the answer of the first choice through
  // the checks of JSON and the output schema.
  const attempt = async <T>(
    request: ModelRequest<T>,
    rejection: Rejection | undefined,
    signal: AbortSignal,
  ): Promise<Attempt<T>> => {
    const answer = await send(request, rejection, signal);
    const usage =
      answer.usage === undefined
        ? undefined
        : {
            inputTokens: answer.usage.prompt_tokens,
            outputTokens: answer.usage.completion_tokens,
          };
    const withUsage = usage === undefined ? {} : { usage };
    // The schema of the answer asks for at least one choice.
    const choice = answer.choices[0] as (typeof answer.choices)[number];
    const refusal = choice.message.refusal;
    if (refusal !== undefined && refusal !== null && refusal !== '') {
      throw fail('upstream', 'The model refused to answer.');
    }
    const reason = choice.finish_reason;
    if (reason === 'length') {
      return { ok: false, rejection: 'length', ...withUsage };
    }
    if (reason !== 'stop' && reason !== undefined && reason !== null) {
      throw fail('upstream', 'The model stopped without an answer.');
    }
    const content = choice.message.content;
    const json = parseModelJson(content ?? '');
    if (!json.ok) return { ok: false, rejection: 'json', ...withUsage };
    let checked;
    try {
      checked = await request.output.validate['~standard'].validate(json.root);
    } catch {
      checked = undefined;
    }
    if (checked === undefined || checked.issues !== undefined) {
      return { ok: false, rejection: 'schema', ...withUsage };
    }
    return { ok: true, value: checked.value, ...withUsage };
  };

  // The tokens of both attempts, only when both reported them.
  const sum = (
    first: TokenUsage | undefined,
    second: TokenUsage | undefined,
  ): TokenUsage | undefined =>
    first === undefined || second === undefined
      ? undefined
      : {
          inputTokens: first.inputTokens + second.inputTokens,
          outputTokens: first.outputTokens + second.outputTokens,
        };

  const generate = async <T>(
    request: ModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>> => {
    const first = await attempt(request, undefined, signal);
    if (first.ok) {
      return Object.freeze({
        value: first.value,
        attempts: 1,
        ...(first.usage === undefined ? {} : { usage: first.usage }),
      });
    }
    // A vendor that follows the schema has no excuse for an answer that
    // does not fit; only a vendor without it gets a second attempt.
    if (native) {
      throw fail(
        'upstream',
        'The answer of the model does not fit its schema.',
      );
    }
    const second = await attempt(request, first.rejection, signal);
    if (!second.ok) {
      throw fail(
        'upstream',
        'The answer of the model does not fit its schema.',
      );
    }
    const usage = sum(first.usage, second.usage);
    return Object.freeze({
      value: second.value,
      attempts: 2,
      ...(usage === undefined ? {} : { usage }),
    });
  };

  return Object.freeze({ info, nativeStructuredOutput: native, generate });
}
