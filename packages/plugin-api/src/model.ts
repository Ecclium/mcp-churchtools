/**
 * The port to a language model (ADR 0033). The runner gives a model data
 * and an output schema, never a tool: the model fills fields of fixed
 * blocks, and the core checks what comes back before anything is written.
 *
 * A provider is an adapter for one vendor and one model, such as the
 * adapter of the core for chat interfaces in the style of OpenAI, or one
 * that a plugin brings. The core never hands a provider a value that the
 * pipeline did not redact: it checks every part with data for the mark of
 * a redacted value before any adapter is called, and it gives the adapter
 * only text. The core builds the transport of an adapter itself, so that
 * an adapter reaches only the origin of its configuration.
 *
 * @packageDocumentation
 */
import type { ProviderInfo } from './audit.js';

/**
 * The result of a check by {@link StandardSchemaV1}: the value on success,
 * otherwise the issues. The core reads only whether there are issues,
 * never their text, which may quote the answer of a model.
 */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly unknown[] };

/**
 * The part of the interface Standard Schema, version 1, that the core
 * uses to check the answer of a model. Schemas of zod 4 have it, so a
 * routine needs no adapter for its schema, and a plugin may use another
 * library that has it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The interface, under its fixed key. */
  readonly '~standard': {
    /** The version of the interface, always 1. */
    readonly version: 1;
    /** The library that made the schema, such as `zod`. */
    readonly vendor: string;
    /** Checks a value and gives it typed, or the issues. */
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    /** Only for types: what the schema takes and gives. */
    readonly types?:
      { readonly input: Input; readonly output: Output } | undefined;
  };
}

/**
 * A part of the prompt as an adapter gets it: the text of the routine, or
 * one input of the run as text in a block with a boundary the core drew
 * for the call. An adapter never gets an object of data.
 */
export type ModelPromptPart =
  | {
      /** The prompt file of the routine. */
      readonly kind: 'instructions';
      /** Its text. */
      readonly text: string;
    }
  | {
      /** One input of the run, redacted. */
      readonly kind: 'data';
      /** The name of the input in the routine. */
      readonly name: string;
      /** The input as JSON in its block, with the boundary on both ends. */
      readonly text: string;
    };

/** What the answer must be: a name, a JSON Schema and its check. */
export interface ModelOutputSpec<T> {
  /**
   * The name of the schema, as {@link isModelOutputName} takes it, which
   * an adapter may pass to the vendor with the schema.
   */
  readonly name: string;
  /** The JSON Schema of the answer, for the vendor. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /**
   * The check of the answer, made from the same definition as the schema.
   * The guard of the core checks the answer of a provider once more with
   * it, so it must take its own output: no transformation, no default
   * that changes a value.
   */
  readonly validate: StandardSchemaV1<unknown, T>;
}

/** One call of a model. */
export interface ModelRequest<T> {
  /** The fixed text of the core, which says that data are no instructions. */
  readonly system: string;
  /** The text of the routine, then the inputs, in this order. */
  readonly parts: readonly ModelPromptPart[];
  /** What the answer must be. */
  readonly output: ModelOutputSpec<T>;
  /** The most tokens of the answer, from 1 to {@link modelLimits}. */
  readonly maxOutputTokens: number;
}

/** The tokens of a call, as the vendor counted them. */
export interface TokenUsage {
  /** The tokens of the prompt, over all attempts. */
  readonly inputTokens: number;
  /** The tokens of the answers, over all attempts. */
  readonly outputTokens: number;
}

/** What a call gives: the checked answer and how many attempts it took. */
export interface ModelResult<T> {
  /** The answer, checked against the output schema. */
  readonly value: T;
  /**
   * 1, or 2 when a provider without structured output asked once more
   * after an answer that was no JSON of the schema (ADR 0033).
   */
  readonly attempts: 1 | 2;
  /** The tokens, where the vendor reported them. */
  readonly usage?: TokenUsage;
}

/**
 * An adapter to one model. The core calls it only through its guard, which
 * checks the request before and the result after the call. `info` and
 * `nativeStructuredOutput` must be own values of the object, not getters;
 * `generate` may come from its class.
 */
export interface ModelProvider {
  /**
   * Vendor, model, country of hosting, host of the endpoint and, outside
   * Switzerland and the EEA, the basis of the transfer, as the
   * configuration names them. Every event of a run carries it.
   */
  readonly info: ProviderInfo;
  /**
   * Whether the vendor follows a JSON Schema for the answer. Without it,
   * the adapter asks for JSON in the text and may try exactly once more.
   */
  readonly nativeStructuredOutput: boolean;
  /**
   * Asks the model for one answer of the output schema.
   *
   * @param request - The system text, the parts, the output schema and the
   *   limit of tokens.
   * @param signal - Aborts the call.
   * @returns The checked answer.
   * @throws {EccliumError} When the vendor fails or the answer does not
   *   fit, with a code and never with text of the vendor. A later try of
   *   the run may pass `network`, `rate_limited` and `upstream`: a vendor
   *   that did not answer, answered with 429 or 5xx, or gave an answer of
   *   an unknown form. It would not change `validation`, for an answer
   *   that does not fit after the attempts allowed, a refusal or another
   *   reason to stop, nor `config`, `auth` and `permission`, for a request,
   *   a key or a right the vendor refuses (ADR 0034).
   */
  generate<T>(
    request: ModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>>;
}

/** The limits of a call of a model, frozen. */
export const modelLimits: {
  readonly maxOutputTokens: number;
  readonly parts: number;
} = Object.freeze({
  /** The most tokens of an answer a request may ask for. */
  maxOutputTokens: 8000,
  /** The most parts of a prompt: the text of the routine and ten inputs. */
  parts: 11,
});

// Lowercase letters, digits and underscores, starting with a letter, as
// the names of a routine. Anchored, without flags.
const outputNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Tells whether a value fits as the name of an output schema or of an
 * input: lowercase letters, digits and underscores, starting with a
 * letter, at most 64 characters.
 *
 * @param value - Any value.
 * @returns Whether it fits.
 * @example
 * ```ts
 * isModelOutputName('dienstplan_report'); // true
 * isModelOutputName('Dienstplan'); // false
 * ```
 */
export function isModelOutputName(value: unknown): value is string {
  return typeof value === 'string' && outputNamePattern.test(value);
}
