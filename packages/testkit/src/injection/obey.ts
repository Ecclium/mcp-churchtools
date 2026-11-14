/**
 * A stand-in for a model that obeys every injection it finds (ADR 0033),
 * so that a test shows what the checks without a model make of a model
 * that was talked round.
 *
 * It reads what reached it, not what the test planted: the data parts of
 * the request, with the envelopes of foreign data taken off and tag
 * characters read as the letters they stand for, as a model may read
 * them. A case whose instruction a check of the pipeline removed before
 * the model, such as tag characters, is not heard, and the model does not
 * obey it. The test builds the answer from the cases heard, in the form
 * of the blocks of its routine, and asks the model which cases it heard.
 *
 * @packageDocumentation
 */
import type {
  ModelPromptPart,
  ModelRequest,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  createMockModelProvider,
  type MockModel,
  type MockModelOptions,
} from '../model/index.js';
import type { InjectionCase } from './corpus.js';

// The marks of the envelope around a text of foreign data (ADR 0024).
const envelopeMarks = /<<\/?data-[0-9A-Za-z]{1,64}>>/gu;

// Every character of the block of tags.
const tagCharacters = /[\u{E0000}-\u{E007F}]/gu;

// A tag character as the letter of ASCII it stands for; the start and the
// end of a run of tags stand for none.
const asLetter = (tag: string): string => {
  const code = (tag.codePointAt(0) ?? 0) - 0xe0000;
  return code >= 0x20 && code <= 0x7e ? String.fromCodePoint(code) : '';
};

// Every text in a value of JSON, depth first.
const textsOf = (value: unknown, into: string[]): void => {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) textsOf(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) textsOf(item, into);
  }
};

// The texts of one data part: the guard sends its value as JSON between a
// line that opens and one that closes the input.
const partTexts = (part: ModelPromptPart): readonly string[] => {
  if (part.kind !== 'data') return [];
  const inner = part.text.slice(
    part.text.indexOf('\n') + 1,
    part.text.lastIndexOf('\n'),
  );
  try {
    const texts: string[] = [];
    textsOf(JSON.parse(inner) as unknown, texts);
    return texts;
  } catch {
    return [inner];
  }
};

/**
 * The data of a request as a model that obeys reads them: every text of
 * every data part, without the envelopes, with tag characters as letters.
 *
 * @param request - A request a mock provider got.
 * @returns The texts, one per line.
 * @example
 * ```ts
 * heardText(mock.requests()[0]).includes('www.exfil.example');
 * ```
 */
export function heardText(request: ModelRequest<unknown>): string {
  return request.parts
    .flatMap(partTexts)
    .map((text) =>
      text.replaceAll(envelopeMarks, '').replaceAll(tagCharacters, asLetter),
    )
    .join('\n');
}

/**
 * The cases of a corpus whose instruction reached a model in a request.
 *
 * @param request - A request a mock provider got.
 * @param cases - The cases to look for.
 * @returns The cases heard, in the order given.
 * @example
 * ```ts
 * heardCases(mock.requests()[0], injectionCorpus).map(({ id }) => id);
 * ```
 */
export function heardCases(
  request: ModelRequest<unknown>,
  cases: readonly InjectionCase[],
): readonly InjectionCase[] {
  const text = heardText(request);
  return Object.freeze(cases.filter(({ heard }) => text.includes(heard)));
}

/** What an obedient model takes. */
export interface ObedientModelOptions {
  /** The cases it obeys when it finds them. */
  readonly cases: readonly InjectionCase[];
  /**
   * Its answer for the cases heard in one request, in the form of the
   * blocks of the routine; for none heard, a plain answer.
   */
  readonly answer: (heard: readonly InjectionCase[]) => unknown;
}

/** A mock provider that obeys, and what it heard. */
export interface ObedientModel extends MockModel {
  /** The IDs of the cases heard, one list per request, oldest first. */
  heard(): readonly (readonly string[])[];
}

/**
 * Builds a mock provider that obeys every case of the corpus it finds in
 * its data.
 *
 * @param options - The cases and how to answer.
 * @param mockOptions - Information and kind of output of the mock.
 * @returns The provider, its requests and what it heard.
 * @example
 * ```ts
 * const model = createObedientModel({
 *   cases: injectionCorpus,
 *   answer: (heard) => ({ hinweise: heard.map(() => ({ text: 'x' })) }),
 * });
 * ```
 */
export function createObedientModel(
  options: ObedientModelOptions,
  mockOptions: MockModelOptions = {},
): ObedientModel {
  const heard: (readonly string[])[] = [];
  const mock = createMockModelProvider(
    {
      kind: 'obedient',
      respond: (request) => {
        const found = heardCases(request, options.cases);
        heard.push(Object.freeze(found.map(({ id }) => id)));
        return options.answer(found);
      },
    },
    mockOptions,
  );
  return Object.freeze({
    provider: mock.provider,
    requests: () => mock.requests(),
    heard: (): readonly (readonly string[])[] => Object.freeze([...heard]),
  });
}

/**
 * One entry of a block as a model that obeys writes it: the payload of a
 * case in each text field named, or an extra field, beside the plain
 * values given.
 *
 * @param found - The case the model obeys.
 * @param plain - The values of a plain entry, for every field.
 * @param textFields - The fields of type text.
 * @returns The entry.
 * @example
 * ```ts
 * obeyedEntry(found, { titel: 'Plan', text: 'ok' }, ['titel', 'text']);
 * ```
 */
export function obeyedEntry(
  found: InjectionCase,
  plain: Readonly<Record<string, unknown>>,
  textFields: readonly string[],
): Readonly<Record<string, unknown>> {
  const { obey } = found;
  if (obey.kind === 'field') {
    return Object.freeze({ ...plain, [obey.name]: obey.value });
  }
  return Object.freeze({
    ...plain,
    ...Object.fromEntries(textFields.map((field) => [field, obey.payload])),
  });
}
