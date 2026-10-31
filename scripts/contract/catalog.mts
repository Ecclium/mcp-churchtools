/**
 * The part `katalog` of the contract check: the catalog of the escape hatch
 * against the OpenAPI document of the instance (ADR 0067).
 *
 * The core reads an operation of the escape hatch only as the generated
 * part of its catalog describes it, `packages/core/src/churchtools/catalog/
 * generated.ts`, and only if the classification by hand allows it. A test
 * holds every operation of the generated part classified, so an operation
 * the document adds is exactly one without a classification: the core
 * refuses it until `pnpm docs:refresh` and a classification by hand take
 * it in. This part builds, with the functions of the refresh, the catalog
 * the document of the instance would give and compares it with the
 * generated part, operation by operation: new in the document, gone from
 * it, another path, another state of deprecation or of the answer, and
 * parameters added, gone or changed.
 *
 * Names of operations and parameters of the generated part stand in the
 * repository and may appear in the output. A name that only the document
 * gives comes from the instance: it appears only in the form the facts
 * allow for such names, otherwise as the fixed word `unlesbar`, and the
 * check of the contract puts it through the block list of the guard, so
 * that a name holding the host or a local value withholds the output.
 *
 * @packageDocumentation
 */
import {
  catalogOperations,
  type CatalogOperationEntry,
  type CatalogParameterEntry,
} from '../docs/lib/catalog.mts';
import { operationFacts } from '../docs/lib/operations.mts';
import { SpikeError } from '../spike/lib/errors.mts';
import type { Json } from '../spike/lib/guard.mts';
import { isObject, type OpenApiDocument } from '../spike/lib/spec.mts';

/** The kinds of a deviation of the catalog, as fixed words. */
export const catalogDeviationKinds = [
  'neu im Dokument',
  'nicht im Dokument',
  'anderer Pfad',
  'veraltet',
  'nicht mehr veraltet',
  'andere Antwort',
  'neuer Parameter',
  'Parameter fehlt',
  'anderer Parameter',
] as const;

/** The other words of the part, for the allow list. */
export const catalogWords = [
  'katalog',
  'abgleich',
  'moeglich',
  'nicht moeglich',
  'operationen',
  'imDokument',
  'gleich',
  'abweichungen',
  'operation',
  'feld',
  'art',
  'unlesbar',
  ...catalogDeviationKinds,
] as const;

/** One place where the document departs from the catalog. */
interface CatalogDeviation {
  readonly operation: string;
  /** The parameter, missing for the operation as a whole. */
  readonly feld?: string;
  readonly art: (typeof catalogDeviationKinds)[number];
}

// The forms of the names the output takes from the document alone: an
// operationId as the facts allow it and a parameter as ct_api_execute_read
// takes it. Any other name stays out.
const operationIdForm = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const parameterNameForm = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/;

const broken = (): SpikeError =>
  new SpikeError('DATEI', 'katalogDateiUngueltig');

const isText = (value: unknown): value is string => typeof value === 'string';

// A parameter of the generated part in the form the refresh writes it.
const parameterOf = (value: unknown): CatalogParameterEntry => {
  if (
    !isObject(value) ||
    !isText(value['name']) ||
    !isText(value['in']) ||
    typeof value['required'] !== 'boolean' ||
    !isText(value['kind']) ||
    (value['list'] !== undefined && value['list'] !== true) ||
    (value['values'] !== undefined &&
      !(Array.isArray(value['values']) && value['values'].every(isText)))
  ) {
    throw broken();
  }
  return value as unknown as CatalogParameterEntry;
};

/**
 * Reads the operations of the generated part from its text: one JSON
 * object per line between `frozenOperations([` and `]);`, as the refresh
 * writes it. The file is TypeScript, which this script does not run.
 *
 * @param text - The text of `generated.ts`.
 * @returns The operations, in their order.
 * @throws {SpikeError} `DATEI` if the text has another form.
 */
export function readCatalog(text: string): CatalogOperationEntry[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'frozenOperations([');
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === ']);',
  );
  if (start === -1 || end === -1) throw broken();
  return lines.slice(start + 1, end).map((line) => {
    const entry = line.trim();
    if (!entry.endsWith(',')) throw broken();
    let value: unknown;
    try {
      value = JSON.parse(entry.slice(0, -1));
    } catch {
      throw broken();
    }
    if (
      !isObject(value) ||
      !isText(value['operationId']) ||
      value['method'] !== 'get' ||
      !isText(value['path']) ||
      typeof value['deprecated'] !== 'boolean' ||
      typeof value['json'] !== 'boolean' ||
      !Array.isArray(value['parameters'])
    ) {
      throw broken();
    }
    return {
      operationId: value['operationId'],
      method: value['method'],
      path: value['path'],
      deprecated: value['deprecated'],
      json: value['json'],
      parameters: value['parameters'].map(parameterOf),
    };
  });
}

// Everything of a parameter the core checks a value against.
const sameParameter = (
  left: CatalogParameterEntry,
  right: CatalogParameterEntry,
): boolean =>
  left.in === right.in &&
  left.required === right.required &&
  left.kind === right.kind &&
  left.list === right.list &&
  JSON.stringify(left.values ?? null) === JSON.stringify(right.values ?? null);

/** What the part found. */
export interface CatalogComparison {
  /** The part of the result. */
  readonly report: Json;
  /**
   * The names of the generated part and the counts, which stand in the
   * repository or say nothing about the instance.
   */
  readonly fixed: readonly string[];
  /** The names only the document of the instance gives. */
  readonly fromDocument: readonly string[];
}

/**
 * Compares the generated part with the catalog the document would give.
 *
 * @param document - The OpenAPI document from the state file.
 * @param catalog - The operations of the generated part.
 * @returns The part of the result and the names it shows.
 */
export function compareCatalog(
  document: OpenApiDocument,
  catalog: readonly CatalogOperationEntry[],
): CatalogComparison {
  let fromDocument: CatalogOperationEntry[];
  try {
    fromDocument = catalogOperations(operationFacts(document));
  } catch {
    // The document has a form the facts cannot hold, as the refresh would
    // also stop on. The comparison of the client still runs.
    return {
      report: { abgleich: 'nicht moeglich' },
      fixed: [],
      fromDocument: [],
    };
  }
  const names = new Set<string>();
  const documentNames = new Set<string>();
  const known = new Map(catalog.map((entry) => [entry.operationId, entry]));
  const documented = new Map(
    fromDocument.map((entry) => [entry.operationId, entry]),
  );
  const deviations: CatalogDeviation[] = [];
  let same = 0;
  for (const entry of catalog) {
    names.add(entry.operationId);
    const other = documented.get(entry.operationId);
    if (other === undefined) {
      deviations.push({
        operation: entry.operationId,
        art: 'nicht im Dokument',
      });
      continue;
    }
    const before = deviations.length;
    if (other.path !== entry.path) {
      deviations.push({ operation: entry.operationId, art: 'anderer Pfad' });
    }
    if (other.deprecated !== entry.deprecated) {
      deviations.push({
        operation: entry.operationId,
        art: other.deprecated ? 'veraltet' : 'nicht mehr veraltet',
      });
    }
    if (other.json !== entry.json) {
      deviations.push({ operation: entry.operationId, art: 'andere Antwort' });
    }
    const parameters = new Map(
      other.parameters.map((parameter) => [parameter.name, parameter]),
    );
    for (const parameter of entry.parameters) {
      names.add(parameter.name);
      const found = parameters.get(parameter.name);
      if (found === undefined) {
        deviations.push({
          operation: entry.operationId,
          feld: parameter.name,
          art: 'Parameter fehlt',
        });
      } else if (!sameParameter(parameter, found)) {
        deviations.push({
          operation: entry.operationId,
          feld: parameter.name,
          art: 'anderer Parameter',
        });
      }
    }
    const declared = new Set(
      entry.parameters.map((parameter) => parameter.name),
    );
    for (const parameter of other.parameters) {
      if (declared.has(parameter.name)) continue;
      const name = parameterNameForm.test(parameter.name)
        ? parameter.name
        : 'unlesbar';
      documentNames.add(name);
      deviations.push({
        operation: entry.operationId,
        feld: name,
        art: 'neuer Parameter',
      });
    }
    if (deviations.length === before) same += 1;
  }
  for (const entry of fromDocument) {
    if (known.has(entry.operationId)) continue;
    const name = operationIdForm.test(entry.operationId)
      ? entry.operationId
      : 'unlesbar';
    documentNames.add(name);
    deviations.push({ operation: name, art: 'neu im Dokument' });
  }
  names.add(String(catalog.length));
  names.add(String(fromDocument.length));
  names.add(String(same));
  return {
    report: {
      abgleich: 'moeglich',
      operationen: catalog.length,
      imDokument: fromDocument.length,
      gleich: same,
      abweichungen: deviations.map((deviation) => ({ ...deviation })),
    },
    fixed: [...names],
    fromDocument: [...documentNames].filter((name) => !names.has(name)),
  };
}
