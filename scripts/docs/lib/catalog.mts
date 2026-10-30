/**
 * The generated part of the operation catalog of the escape hatch (ADR
 * 0067): from the facts of the OpenAPI document, every GET operation with
 * its path, its parameters and their kinds, and no text of the document.
 * `pnpm docs:refresh` writes it into the core, which does not read the
 * facts itself; a test compares the file with what this module makes.
 *
 * @packageDocumentation
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { SpikeError } from '../../spike/lib/errors.mts';
import { isObject } from '../../spike/lib/spec.mts';

/** Where the generated part lies in the core. */
export const defaultCatalogFile = new URL(
  '../../../packages/core/src/churchtools/catalog/generated.ts',
  import.meta.url,
);

/** A parameter as the generated part writes it. */
export interface CatalogParameterEntry {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly kind: string;
  readonly list?: true;
  readonly values?: readonly string[];
}

/** An operation as the generated part writes it. */
export interface CatalogOperationEntry {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly deprecated: boolean;
  readonly json: boolean;
  readonly parameters: readonly CatalogParameterEntry[];
}

interface Kind {
  readonly kind: string;
  readonly list?: true;
  readonly values?: readonly string[];
}

const unsupported: Kind = { kind: 'unsupported' };

// Query names the transport sends: letters, digits and underscores with an
// optional [] (ADR 0056), never one that hands over a token or a session.
const isSendableName = (name: string): boolean => {
  const base = name.endsWith('[]') ? name.slice(0, -2) : name;
  if (base.length === 0) return false;
  for (let index = 0; index < base.length; index += 1) {
    const code = base.charCodeAt(index);
    const fits =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f;
    if (!fits) return false;
  }
  const lower = base.toLowerCase();
  return lower !== 'login_token' && lower !== 'with_session';
};

const typesOf = (shape: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(shape['type'])
    ? shape['type'].filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry !== 'null',
      )
    : [];

// A string with the format date or date-time.
const dateFormat = (shape: unknown): string | undefined => {
  if (!isObject(shape)) return undefined;
  const types = typesOf(shape);
  const format = shape['format'];
  return types.length === 1 &&
    types[0] === 'string' &&
    (format === 'date' || format === 'date-time')
    ? format
    : undefined;
};

// The kind of a single value, never a list.
const scalarKind = (shape: unknown): Kind => {
  if (!isObject(shape)) return unsupported;
  const types = typesOf(shape);
  if (types.length === 0) {
    // A choice of a day and a moment, as the document writes dates of
    // appointments and of searches.
    const choice = Array.isArray(shape['anyOf'])
      ? shape['anyOf']
      : Array.isArray(shape['oneOf'])
        ? shape['oneOf']
        : undefined;
    if (choice === undefined || choice.length === 0) return unsupported;
    const formats = new Set(choice.map(dateFormat));
    if (formats.has(undefined)) return unsupported;
    if (formats.size === 2) return { kind: 'date-or-date-time' };
    return formats.has('date') ? { kind: 'date' } : { kind: 'date-time' };
  }
  if (types.length !== 1) return unsupported;
  const type = types[0];
  if (type === 'integer') return { kind: 'integer' };
  if (type === 'number') return { kind: 'number' };
  if (type === 'boolean') return { kind: 'boolean' };
  if (type !== 'string') return unsupported;
  if (Array.isArray(shape['enum'])) {
    const values = shape['enum'].filter(
      (entry): entry is string => typeof entry === 'string',
    );
    return values.length === 0 ? unsupported : { kind: 'enum', values };
  }
  const format = shape['format'];
  if (format === 'date') return { kind: 'date' };
  if (format === 'date-time') return { kind: 'date-time' };
  return { kind: 'string' };
};

const kindOf = (shape: unknown): Kind => {
  if (
    isObject(shape) &&
    typesOf(shape).length === 1 &&
    typesOf(shape)[0] === 'array'
  ) {
    const item = scalarKind(shape['items']);
    return item.kind === 'unsupported' ? unsupported : { ...item, list: true };
  }
  return scalarKind(shape);
};

const text = (value: unknown, where: string): string => {
  if (typeof value !== 'string') {
    throw new SpikeError('DATEI', 'katalogUngueltig', where);
  }
  return value;
};

const parameterEntry = (parameter: unknown): CatalogParameterEntry => {
  if (!isObject(parameter) || typeof parameter['required'] !== 'boolean') {
    throw new SpikeError('DATEI', 'katalogUngueltig', 'parameters');
  }
  const name = text(parameter['name'], 'parameters.name');
  const where = text(parameter['in'], 'parameters.in');
  let kind = kindOf(parameter['schema']);
  if (where === 'header' || where === 'cookie') kind = unsupported;
  // A list goes value by value under its name, which PHP reads as a list
  // only with [] at the end.
  if (
    where === 'query' &&
    (!isSendableName(name) || (kind.list === true && !name.endsWith('[]')))
  ) {
    kind = unsupported;
  }
  return {
    name,
    in: where,
    required: parameter['required'],
    kind: kind.kind,
    ...(kind.list === true ? { list: true as const } : {}),
    ...(kind.values === undefined ? {} : { values: kind.values }),
  };
};

const isJsonOnly = (responses: unknown): boolean => {
  if (!Array.isArray(responses)) {
    throw new SpikeError('DATEI', 'katalogUngueltig', 'responses');
  }
  const types = new Set<string>();
  for (const response of responses) {
    if (!isObject(response) || !Array.isArray(response['content'])) {
      throw new SpikeError('DATEI', 'katalogUngueltig', 'responses');
    }
    const status = text(response['status'], 'responses.status');
    if (!status.startsWith('2')) continue;
    for (const content of response['content']) {
      types.add(
        text(
          isObject(content) ? content['mediaType'] : undefined,
          'responses.content',
        ),
      );
    }
  }
  return types.size === 1 && types.has('application/json');
};

/**
 * The operations of the generated part from the entries of
 * `operations.json`: every GET, in the order of the facts, with the path
 * under `/api`.
 *
 * @param entries - The entries of the facts about the operations.
 * @returns The operations of the generated part.
 * @throws {SpikeError} `DATEI` if an entry does not have the form of the
 *   facts.
 */
export function catalogOperations(
  entries: readonly unknown[],
): CatalogOperationEntry[] {
  const operations: CatalogOperationEntry[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      throw new SpikeError('DATEI', 'katalogUngueltig', 'entries');
    }
    const method = text(entry['method'], 'method');
    if (method !== 'get') continue;
    const parameters = entry['parameters'];
    if (
      !Array.isArray(parameters) ||
      typeof entry['deprecated'] !== 'boolean'
    ) {
      throw new SpikeError('DATEI', 'katalogUngueltig', 'entries');
    }
    operations.push({
      operationId: text(entry['operationId'], 'operationId'),
      method,
      path: `/api${text(entry['path'], 'path')}`,
      deprecated: entry['deprecated'],
      json: isJsonOnly(entry['responses']),
      parameters: parameters.map(parameterEntry),
    });
  }
  return operations;
}

/**
 * The text of the generated part: a TypeScript module with one operation
 * per line, so that a new version of ChurchTools shows in the diff as
 * whole lines.
 *
 * @param operations - The operations from {@link catalogOperations}.
 * @returns The text of `generated.ts`.
 */
export function catalogText(
  operations: readonly CatalogOperationEntry[],
): string {
  const lines = operations.map(
    (operation) => `  ${JSON.stringify(operation)},`,
  );
  return [
    '/**',
    ' * The GET operations of the OpenAPI document of ChurchTools for the escape',
    ' * hatch (ADR 0067), without any text of the document. Written by',
    ' * `pnpm docs:refresh` from `packages/docs-index/data/operations.json`;',
    ' * never edit it by hand, a test compares it with the facts.',
    ' *',
    ' * @packageDocumentation',
    ' */',
    "import { frozenOperations, type GeneratedOperation } from './types.js';",
    '',
    '/** Every GET operation of the facts, in their order. */',
    'export const generatedOperations: readonly GeneratedOperation[] =',
    '  frozenOperations([',
    ...lines.map((line) => `  ${line}`),
    '  ]);',
    '',
  ].join('\n');
}

/**
 * Writes the generated part through a temporary file next to it, so that
 * a failed write leaves the old file.
 *
 * @param text - The text of the generated part.
 * @param file - Where it goes.
 * @throws {Error} The error of the file system, when the temporary file
 *   cannot be written or renamed.
 */
export function writeCatalog(text: string, file: URL): void {
  const temporary = new URL(`${file.href}.refresh`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', flush: true });
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Not a file of this run, such as a folder in its place: it stays.
    }
    throw error;
  }
  renameSync(temporary, file);
}
