/**
 * The guard before every adapter of a language model (ADR 0033).
 *
 * Where it stands in a run: between the engine, which has read and
 * redacted the inputs, and the adapter that sends them to the vendor. The
 * engine never calls an adapter itself, only the guard that the
 * composition root wraps around it, also around an adapter of a plugin.
 *
 * Why it exists: a part of the prompt with data must be a value the
 * pipeline redacted, or a list of such values for an input of several
 * calls, and the mark of such a value is known only in core,
 * so an adapter of a plugin could not check it. The guard checks every
 * part before the adapter sees anything and stops the call otherwise, so
 * that not even a mistake in the code sends a raw value to the vendor
 * (T17 in the threat model). Then it turns each part into text in a block
 * with a boundary drawn for the call, so an adapter gets only text and
 * never an object of data. After the call it checks the result again: the
 * attempts, the tokens and the answer against the schema of the routine,
 * because an adapter of a plugin is code the core does not know.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  EccliumError,
  type ErrorCode,
  isEccliumError,
  isModelOutputName,
  modelLimits,
  type ModelOutputSpec,
  type ModelPromptPart,
  type ModelProvider,
  type ModelResult,
  type ProviderInfo,
  type StandardSchemaResult,
  type TokenUsage,
} from '@ecclium/mcp-churchtools-plugin-api';

import { auditFieldSchemas } from '../audit/schema.js';
import { isRedacted } from '../redaction/redacted.js';
import { checkTransferBasis } from './countries.js';

/** A part of the prompt as the engine gives it to the guard. */
export type GuardedPromptPart =
  | {
      /** The prompt file of the routine. */
      readonly kind: 'instructions';
      /** Its text. */
      readonly text: string;
    }
  | {
      /** One input of the run. */
      readonly kind: 'data';
      /** The name of the input in the routine. */
      readonly name: string;
      /**
       * The result of the input as the pipeline redacted it, in the level
       * of the call of the model, or the list of the results of its calls,
       * for an input with several pages or one call per entry of another
       * (ADR 0033). Any other value stops the call.
       */
      readonly value: unknown;
    };

/** One call of a model, as the engine gives it to the guard. */
export interface GuardedModelRequest<T> {
  /** The fixed text of the core, which says that data are no instructions. */
  readonly system: string;
  /** The text of the routine, then the inputs, in this order. */
  readonly parts: readonly GuardedPromptPart[];
  /** What the answer must be. */
  readonly output: ModelOutputSpec<T>;
  /** The most tokens of the answer. */
  readonly maxOutputTokens: number;
}

/** A provider behind the guard, the only form in which the engine gets one. */
export interface GuardedModel {
  /** The checked and frozen information of the provider. */
  readonly info: ProviderInfo;
  /** Whether the vendor follows a JSON Schema for the answer. */
  readonly nativeStructuredOutput: boolean;
  /**
   * Checks the request, calls the provider and checks its result.
   *
   * @param request - System text, parts, output schema and limit.
   * @param signal - Aborts the call.
   * @returns The answer, checked again against the output schema.
   * @throws {EccliumError} `internal` for a request the guard refuses,
   *   such as a part that is not redacted, `validation` for an answer that
   *   does not fit its schema, and the code of the failure of the
   *   provider, never with its text.
   */
  generate<T>(
    request: GuardedModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>>;
}

/** What the guard takes besides the provider. */
export interface ModelGuardOptions {
  /**
   * The source of random bytes for the boundary of the blocks,
   * `randomBytes` of `node:crypto` unless a test fixes the boundary.
   */
  readonly random?: (size: number) => Uint8Array;
}

// A part after its check: the text of the routine, or an input as JSON.
type CheckedPart =
  | { readonly kind: 'instructions'; readonly text: string }
  | { readonly kind: 'data'; readonly name: string; readonly json: string };

// The codes a failure of a provider keeps. Any other code, such as one
// of the write guard, means nothing for a call of a model and becomes
// `upstream`. `validation` is an answer that did not fit its schema after
// the attempts allowed, which a later try of the run would not change, as
// against `upstream`, a vendor that failed (ADR 0034).
const providerCodes: readonly ErrorCode[] = Object.freeze([
  'config',
  'auth',
  'permission',
  'rate_limited',
  'upstream',
  'network',
  'validation',
  'internal',
]);

/** The most results of the pipeline one part of a prompt may hold. */
export const maxResultsPerPart = 400;

// How often a boundary is drawn before the guard gives up. A boundary of
// 64 random bits that one of the texts already holds is no accident, so a
// second collision ends the call.
const boundaryDraws = 2;

const refuse = (message: string): EccliumError =>
  new EccliumError('internal', message);

const unfit = (): EccliumError =>
  new EccliumError(
    'upstream',
    'The model provider gave a result the core does not take.',
  );

// An own data property, never a getter, of an object that is no proxy;
// undefined for anything else.
const own = (target: unknown, key: string): unknown => {
  if (typeof target !== 'object' || target === null || isProxy(target)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

// The information of a provider, checked with the patterns of the audit,
// in which it lands with every event of a run, and with the rule of the
// country and the basis of the transfer.
const checkInfo = (info: unknown): ProviderInfo => {
  const vendor = auditFieldSchemas.vendor.safeParse(own(info, 'vendor'));
  const model = auditFieldSchemas.model.safeParse(own(info, 'model'));
  const country = auditFieldSchemas.hostingCountry.safeParse(
    own(info, 'hostingCountry'),
  );
  const host = auditFieldSchemas.endpointHost.safeParse(
    own(info, 'endpointHost'),
  );
  const given = own(info, 'transferBasis');
  const basis =
    given === undefined ? undefined : auditFieldSchemas.term.safeParse(given);
  if (
    !vendor.success ||
    !model.success ||
    !country.success ||
    !host.success ||
    basis?.success === false ||
    checkTransferBasis(country.data, basis?.data) !== undefined
  ) {
    throw new EccliumError(
      'config',
      'A model provider names its vendor, model, country, host or basis of transfer in a form the core does not take.',
    );
  }
  return Object.freeze({
    vendor: vendor.data,
    model: model.data,
    hostingCountry: country.data,
    endpointHost: host.data,
    ...(basis === undefined ? {} : { transferBasis: basis.data }),
  });
};

// A property of the check of an answer, read as a property. The check
// comes from the engine, not from a provider, and libraries such as zod
// define `~standard` as a getter on the prototype of a schema, so an own
// value would refuse every schema that has not been used yet.
const property = (target: unknown, key: string): unknown =>
  typeof target === 'object' && target !== null
    ? (target as Readonly<Record<string, unknown>>)[key]
    : undefined;

// The output schema, checked for its form: a name, a JSON Schema as a
// plain object and a check after Standard Schema version 1.
const checkOutput = <T>(output: unknown): ModelOutputSpec<T> => {
  const name = own(output, 'name');
  const jsonSchema = own(output, 'jsonSchema');
  const validate = own(output, 'validate');
  const standard = property(validate, '~standard');
  if (
    !isModelOutputName(name) ||
    !isPlainObject(jsonSchema) ||
    property(standard, 'version') !== 1 ||
    typeof property(standard, 'validate') !== 'function'
  ) {
    throw refuse('The output schema of a call of a model is not complete.');
  }
  return Object.freeze({
    name,
    jsonSchema: jsonSchema as Readonly<Record<string, unknown>>,
    validate: validate as ModelOutputSpec<T>['validate'],
  });
};

// The values of a plain list, no proxy, of at most so many values, each
// with the mark of the pipeline, read by index as own data, never through
// a getter, copied into a list of the guard's own. The list may hold no
// key besides its indices and its length, so that no own `toJSON` decides
// what is sent. An empty list is an input whose calls found nothing.
// Undefined for anything else; the proxy is asked first, because a revoked
// one would throw in `Array.isArray`.
const redactedListOf = (value: unknown): readonly unknown[] | undefined => {
  if (
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxResultsPerPart ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (
      property === undefined ||
      !('value' in property) ||
      !isRedacted(property.value)
    ) {
      return undefined;
    }
    copy.push(property.value);
  }
  return copy;
};

// The parts, checked: the text of the routine as a string, and each input
// with a name and a value that carries the mark of the pipeline.
const checkParts = (parts: unknown): readonly CheckedPart[] => {
  if (
    !Array.isArray(parts) ||
    isProxy(parts) ||
    parts.length < 1 ||
    parts.length > modelLimits.parts
  ) {
    throw refuse('The parts of a call of a model are not in order.');
  }
  // The map of the class, so that no own or inherited map of the list
  // decides what is checked.
  return Array.prototype.map.call(parts, (part: unknown): CheckedPart => {
    const kind = own(part, 'kind');
    if (kind === 'instructions') {
      const text = own(part, 'text');
      if (typeof text !== 'string') {
        throw refuse('The parts of a call of a model are not in order.');
      }
      return { kind, text };
    }
    const name = own(part, 'name');
    const value = own(part, 'value');
    if (kind !== 'data' || !isModelOutputName(name)) {
      throw refuse('The parts of a call of a model are not in order.');
    }
    // The one check this guard exists for: a value without the mark of
    // the pipeline never reaches an adapter. An input of several calls is
    // a plain list of such values, each checked, so that no value is
    // marked twice and only the pipeline makes a mark (ADR 0026).
    const checked = isRedacted(value) ? value : redactedListOf(value);
    if (checked === undefined) {
      throw refuse(
        'A part of the prompt holds data the pipeline did not redact.',
      );
    }
    // A value of the pipeline is plain JSON. Anything else, such as a
    // cycle, ends the call without the message of the parser, which could
    // name a part of the value. A list goes out as the copy that was
    // checked, never as the list the caller holds.
    let json: string;
    try {
      json = JSON.stringify(checked);
    } catch {
      throw refuse('A part of the prompt is no JSON.');
    }
    return { kind, name, json };
  }) as readonly CheckedPart[];
};

// A boundary of 64 random bits as hex that none of the texts holds, so
// that no text of an input can close its block or open another.
const drawBoundary = (
  random: (size: number) => Uint8Array,
  texts: readonly string[],
): string => {
  for (let draw = 0; draw < boundaryDraws; draw += 1) {
    const boundary = Buffer.from(random(8)).toString('hex');
    if (
      boundary.length === 16 &&
      !texts.some((text) => text.includes(boundary))
    ) {
      return boundary;
    }
  }
  throw refuse('No boundary for the blocks of a call of a model was found.');
};

// The result of a provider, checked: one or two attempts, two only without
// structured output, the tokens as counts, and the answer once more
// against the output schema.
const checkResult = async <T>(
  result: unknown,
  output: ModelOutputSpec<T>,
  native: boolean,
): Promise<ModelResult<T>> => {
  const attempts = own(result, 'attempts');
  const usage = own(result, 'usage');
  if (
    !isPlainObject(result) ||
    (attempts !== 1 && attempts !== 2) ||
    (attempts === 2 && native)
  ) {
    throw unfit();
  }
  let tokens: TokenUsage | undefined;
  if (usage !== undefined) {
    const inputTokens = own(usage, 'inputTokens');
    const outputTokens = own(usage, 'outputTokens');
    if (!isCount(inputTokens) || !isCount(outputTokens)) throw unfit();
    tokens = Object.freeze({ inputTokens, outputTokens });
  }
  let checked: StandardSchemaResult<T> | undefined;
  try {
    checked = await output.validate['~standard'].validate(own(result, 'value'));
  } catch {
    checked = undefined;
  }
  // An answer that does not fit is no failure of the vendor: a later try
  // of the run would not change it (ADR 0034).
  if (checked === undefined || checked.issues !== undefined) {
    throw new EccliumError(
      'validation',
      'The answer of the model does not fit its schema.',
    );
  }
  return Object.freeze({
    value: checked.value,
    attempts,
    ...(tokens === undefined ? {} : { usage: tokens }),
  });
};

/**
 * Wraps a provider in the guard. The composition root does this for every
 * provider, that of the core and those of plugins, and the engine gets
 * only the guarded form.
 *
 * @param provider - The adapter to one model.
 * @param options - Only for tests: the source of random bytes.
 * @returns The guarded provider, frozen.
 * @throws {EccliumError} `config` when the provider is not complete or its
 *   information does not fit the patterns of the audit or the rule of
 *   country and basis of transfer.
 * @example
 * ```ts
 * const model = guardModelProvider(createOpenAiCompatibleProvider(options));
 * const answer = await model.generate(request, signal);
 * ```
 */
export function guardModelProvider(
  provider: ModelProvider,
  options: ModelGuardOptions = {},
): GuardedModel {
  const info = checkInfo(own(provider, 'info'));
  const native = own(provider, 'nativeStructuredOutput');
  // The information and the kind of output are own values, so that no
  // getter can answer differently later. The function may come from the
  // class of an adapter: it runs code of the provider anyway.
  const call = property(provider, 'generate');
  if (typeof native !== 'boolean' || typeof call !== 'function') {
    throw new EccliumError('config', 'A model provider is not complete.');
  }
  const random = options.random ?? randomBytes;

  const generate = async <T>(
    request: GuardedModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>> => {
    const system = own(request, 'system');
    const limit = own(request, 'maxOutputTokens');
    if (
      typeof system !== 'string' ||
      system.length === 0 ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > modelLimits.maxOutputTokens ||
      !(signal instanceof AbortSignal)
    ) {
      throw refuse('A call of a model is not in order.');
    }
    const output = checkOutput<T>(own(request, 'output'));
    const parts = checkParts(own(request, 'parts'));
    const boundary = drawBoundary(random, [
      system,
      ...parts.map((part) => (part.kind === 'data' ? part.json : part.text)),
    ]);
    const sent: readonly ModelPromptPart[] = Object.freeze(
      parts.map((part): ModelPromptPart =>
        Object.freeze(
          part.kind === 'data'
            ? {
                kind: 'data',
                name: part.name,
                text: `<<input-${part.name}-${boundary}>>\n${part.json}\n<</input-${part.name}-${boundary}>>`,
              }
            : { kind: 'instructions', text: part.text },
        ),
      ),
    );
    let result: unknown;
    try {
      result = await (call as ModelProvider['generate']).call(
        provider,
        Object.freeze({
          system,
          parts: sent,
          output,
          maxOutputTokens: limit as number,
        }),
        signal,
      );
    } catch (error) {
      // The code stays where it means something for a call of a model;
      // the text of the provider never leaves.
      throw new EccliumError(
        isEccliumError(error) && providerCodes.includes(error.code)
          ? error.code
          : 'upstream',
        'The call of the model failed.',
      );
    }
    return checkResult(result, output, native);
  };

  return Object.freeze({ info, nativeStructuredOutput: native, generate });
}
