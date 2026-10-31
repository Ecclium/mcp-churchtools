/**
 * What the parts of the course of the smoke test share: the reading of a
 * result of `tools/call`, the data envelope and the steps a part of the
 * course gets to call tools and record what it found.
 *
 * @packageDocumentation
 */
import type { Json } from '../spike/lib/guard.mts';
import type { Answer } from './session.mts';

/**
 * Whether a value is a plain object of JSON.
 *
 * @param value - Any parsed value.
 * @returns Whether it is an object that is no list.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether an object has exactly these keys, no more and no fewer.
 *
 * @param value - The object.
 * @param keys - The keys it must have.
 * @returns Whether its keys are these.
 */
export const sameKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  JSON.stringify(Object.keys(value).sort()) ===
  JSON.stringify([...keys].sort());

/**
 * The data envelope of the pipeline: a boundary of 16 random hex digits,
 * the text without the closing marker, the same boundary again (ADR 0024).
 */
export const envelope =
  /^<<data-([0-9a-f]{16})>>((?:(?!<<\/data-\1>>)[\s\S])*)<<\/data-\1>>$/;

/**
 * The text inside the data envelope.
 *
 * @param value - A text of a result.
 * @returns The text inside, or `undefined` if the value is no text in an envelope.
 */
export const unwrap = (value: unknown): string | undefined =>
  typeof value === 'string' ? envelope.exec(value)?.[2] : undefined;

/** One result of `tools/call` as the course reads it. */
export interface ToolResult {
  readonly isError: boolean;
  /** The structured data, only if the text copy says the same. */
  readonly data: Record<string, unknown> | undefined;
  /** The text of the first content block, empty without one. */
  readonly text: string;
}

/**
 * Reads the result of `tools/call`. A result carries its data twice, as
 * text and structured (ADR 0024). A client may read either, so both must
 * say the same, or the data count as missing.
 *
 * @param answer - The answer of the server.
 * @returns The result, or `undefined` if the answer is none.
 */
export const toolResult = (answer: Answer): ToolResult | undefined => {
  if (answer.kind !== 'result' || !isRecord(answer.result)) return undefined;
  const structured = answer.result['structuredContent'];
  const content = answer.result['content'];
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = isRecord(first) ? first['text'] : undefined;
  const same =
    isRecord(structured) &&
    Array.isArray(content) &&
    content.length === 1 &&
    text === JSON.stringify(structured);
  return {
    isError: answer.result['isError'] === true,
    data: same ? structured : undefined,
    text: typeof text === 'string' ? text : '',
  };
};

/** One call of a tool and the outcome the audit must show for it. */
export interface Call {
  readonly tool: string;
  /** `ok`, or an error with this code. */
  readonly expect: 'ok' | 'validation' | 'not_found' | 'policy_denied';
}

/** What a part of the course gets from the course. */
export interface Steps {
  /**
   * Calls a tool and notes the call with the outcome the audit must show.
   *
   * @param name - The tool.
   * @param args - Its arguments.
   * @param expect - The outcome for the audit.
   * @returns The result, or `undefined` if the server gave none.
   */
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    expect: Call['expect'],
  ) => Promise<ToolResult | undefined>;
  /**
   * Puts a text from ChurchTools onto the block list of the guard and the
   * list of texts no line of log or audit may hold.
   */
  readonly see: (value: unknown) => void;
  /** Puts every value of an answer of ChurchTools onto the block list. */
  readonly block: (value: unknown) => void;
  /** Notes a failed check by its fixed code. */
  readonly fail: (code: string) => void;
  /** Adds the fixed words of one call to the result. */
  readonly report: (entry: { readonly [key: string]: Json }) => void;
  /** Notes a listed tool the course had nothing to call with. */
  readonly withoutData: (tool: string) => void;
}
