/**
 * Stand-ins for a language model (ADR 0033), for tests of the guard, the
 * engine and the runner, which must never reach a real vendor (ADR 0052).
 *
 * A mock provider plays one of four parts: obedient, which answers what a
 * function of the test gives, also a function that follows an instruction
 * in the data, so that a test shows what a run makes of a model that obeys
 * an injection; failing with a code; slow, which waits until the call is
 * aborted; and one whose answer does not fit the schema. Every mock keeps
 * the requests it got, so that a test shows what reached the model.
 *
 * `chatCompletion` writes the body of an answer of a chat interface in the
 * style of OpenAI, for the double of the endpoint.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type ErrorCode,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ProviderInfo,
} from '@ecclium/mcp-churchtools-plugin-api';

/** The information of every mock: a placeholder vendor in Switzerland. */
export const mockProviderInfo: ProviderInfo = Object.freeze({
  vendor: 'example',
  model: 'example-model-1',
  hostingCountry: 'CH',
  endpointHost: 'model.example.org',
});

/** The part a mock plays. */
export type MockModelBehaviour =
  | {
      /** Answers what the function gives, as the value of one attempt. */
      readonly kind: 'obedient';
      readonly respond: (request: ModelRequest<unknown>) => unknown;
    }
  | {
      /** Fails every call with the code. */
      readonly kind: 'failing';
      readonly code: ErrorCode;
    }
  | {
      /** Waits until the signal aborts, then fails with `network`. */
      readonly kind: 'slow';
    }
  | {
      /** Answers a value that does not fit any schema of a routine. */
      readonly kind: 'wrongJson';
    };

/** A mock provider and what it got. */
export interface MockModel {
  /** The provider, to be wrapped by the guard of core. */
  readonly provider: ModelProvider;
  /** Every request so far, oldest first. */
  requests(): readonly ModelRequest<unknown>[];
}

/** What a mock takes besides its part. */
export interface MockModelOptions {
  /** The information, by default {@link mockProviderInfo}. */
  readonly info?: ProviderInfo;
  /** Whether it claims structured output, by default true. */
  readonly nativeStructuredOutput?: boolean;
}

// The answer of a mock that does not fit: a field no block has, a number
// where text belongs and text far beyond any limit of a field.
const wrongValue = Object.freeze({
  unexpected: true,
  text: 42,
  long: 'x'.repeat(5000),
});

/**
 * Builds a mock provider that plays one part.
 *
 * @param behaviour - The part: obedient, failing, slow or wrong JSON.
 * @param options - Information and kind of output, if not the defaults.
 * @returns The provider and the list of its requests.
 * @example
 * ```ts
 * const mock = createMockModelProvider({
 *   kind: 'obedient',
 *   respond: () => ({ hinweise: [] }),
 * });
 * const model = guardModelProvider(mock.provider);
 * ```
 */
export function createMockModelProvider(
  behaviour: MockModelBehaviour,
  options: MockModelOptions = {},
): MockModel {
  const requests: ModelRequest<unknown>[] = [];
  const generate = async <T>(
    request: ModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>> => {
    requests.push(request);
    switch (behaviour.kind) {
      case 'obedient':
        return { value: (await behaviour.respond(request)) as T, attempts: 1 };
      case 'failing':
        throw new EccliumError(behaviour.code, 'The mock model failed.');
      case 'slow':
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        });
        throw new EccliumError('network', 'The mock model was aborted.');
      case 'wrongJson':
        return { value: wrongValue as T, attempts: 1 };
    }
  };
  return Object.freeze({
    provider: Object.freeze({
      info: options.info ?? mockProviderInfo,
      nativeStructuredOutput: options.nativeStructuredOutput ?? true,
      generate,
    }),
    requests: (): readonly ModelRequest<unknown>[] =>
      Object.freeze([...requests]),
  });
}

/** The headers of an answer of JSON, for an interceptor. */
export const jsonHeaders: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
});

/** What an answer of a chat interface holds. */
export interface ChatCompletionOptions {
  /** The text of the answer, or null. */
  readonly content: string | null;
  /** Why the model stopped, by default `stop`. */
  readonly finishReason?: string;
  /** The tokens, if the vendor reports them. */
  readonly usage?: { readonly prompt: number; readonly completion: number };
  /** A refusal of the model, if it refused. */
  readonly refusal?: string;
}

/**
 * Writes the body of an answer of a chat interface in the style of OpenAI,
 * with one choice.
 *
 * @param options - Text, reason to stop, tokens and refusal.
 * @returns The body as JSON.
 * @example
 * ```ts
 * chatCompletion({ content: '{"hinweise":[]}' });
 * ```
 */
export function chatCompletion(options: ChatCompletionOptions): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: options.content,
          ...(options.refusal === undefined
            ? {}
            : { refusal: options.refusal }),
        },
        finish_reason: options.finishReason ?? 'stop',
      },
    ],
    ...(options.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: options.usage.prompt,
            completion_tokens: options.usage.completion,
            total_tokens: options.usage.prompt + options.usage.completion,
          },
        }),
  });
}
