/**
 * The mapping by hand that `pnpm docs:refresh` carries into the facts
 * (ADR 0066): labels and explaining help pages of the rights, and which
 * rights each operation needs, with evidence for every pairing. A person
 * writes `scripts/docs/rights-mapping.json`; the refresh checks it against
 * the facts it made, puts the labels and pages into `rights.json` and
 * writes the pairings as `operation-rights.json`. So no person writes the
 * files under `data/`.
 *
 * This module checks the form and the order, that every operation, right
 * and page exists and that a label from a help page stands there right
 * before the name of its right. The
 * other rules of evidence, such as a description that names the right,
 * the checks of the package hold when `pnpm build` reads the files. The
 * scripts load no package (ADR 0020), so the order of the fields stands
 * here a second time.
 *
 * @packageDocumentation
 */
import { SpikeError } from '../../spike/lib/errors.mts';
import { isObject } from '../../spike/lib/spec.mts';
import type { AcademyPageEntry } from './academy.mts';
import type { RightFactEntry } from './rights.mts';

/** The file of the mapping, next to the refresh. */
export const defaultMappingFile = new URL(
  '../rights-mapping.json',
  import.meta.url,
);

/** The format the file names. */
export const mappingFormat = 'ecclium.docs.rights-mapping.v1';

/** A label from a help page or from a finding. */
export type LabelEntry =
  | { readonly text: string; readonly page: string }
  | {
      readonly text: string;
      readonly finding: string;
      readonly version: string;
    };

/** A right with its label and explaining pages. */
export interface MappedRight {
  readonly module: string;
  readonly name: string;
  readonly label?: LabelEntry;
  readonly pages: readonly string[];
}

/** A right by module and name. */
export interface RightRefEntry {
  readonly module: string;
  readonly name: string;
}

/** One piece of evidence. */
export type EvidenceEntry =
  | {
      readonly kind: 'finding';
      readonly id: string;
      readonly version: string;
      readonly shows?: 'necessary' | 'sufficient';
    }
  | { readonly kind: 'openapi' }
  | { readonly kind: 'academy'; readonly page: string };

/** A right an operation needs, one of `rights` sufficing. */
export interface NeedEntry {
  readonly rights: readonly RightRefEntry[];
  readonly without?: 'fields' | 'omitted' | 'refused';
  readonly evidence: readonly EvidenceEntry[];
}

/** A right a finding showed an operation does not need. */
export interface NotNeededEntry {
  readonly right: RightRefEntry;
  readonly evidence: readonly EvidenceEntry[];
}

/** One entry of `operation-rights.json`. */
export type OperationRightsEntry =
  | {
      readonly operationId: string;
      readonly needs: readonly NeedEntry[];
      readonly notNeeded?: readonly NotNeededEntry[];
    }
  | { readonly operationId: string; readonly none: readonly EvidenceEntry[] }
  | {
      readonly operationId: string;
      readonly open: string;
      readonly notNeeded?: readonly NotNeededEntry[];
    };

/** The mapping, checked for its form and its order. */
export interface RightsMapping {
  readonly rights: readonly MappedRight[];
  readonly operations: readonly OperationRightsEntry[];
}

/** The rights with their labels and the pairings, ready for the files. */
export interface AppliedMapping {
  readonly rights: readonly RightFactEntry[];
  readonly operationRights: readonly OperationRightsEntry[];
}

function fail(where: string): never {
  throw new SpikeError('DATEI', 'zuordnungUngueltig', `mapping.${where}`);
}

// Fields a value of the file must have and may have, in the order the
// format writes them; any other field is a mistake.
function fields(
  value: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isObject(value)) {
    return fail(where);
  }
  const known = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !known.has(key)) ||
    required.some((key) => !(key in value))
  ) {
    return fail(where);
  }
  return value;
}

function text(value: unknown, where: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fail(where);
}

function list(value: unknown, where: string, min = 1): readonly unknown[] {
  return Array.isArray(value) && value.length >= min ? value : fail(where);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  return allowed.find((item) => item === value) ?? fail(where);
}

// Code units, not the locale, like every order of the facts.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const apart = String.fromCodePoint(0);

function refKey(right: RightRefEntry): string {
  return `${right.module}${apart}${right.name}`;
}

function evidenceKey(evidence: EvidenceEntry): string {
  switch (evidence.kind) {
    case 'finding':
      return `finding${apart}${evidence.id}`;
    case 'academy':
      return `academy${apart}${evidence.page}`;
    case 'openapi':
      return 'openapi';
  }
}

// Every list stands in the order of the format and holds nothing twice,
// as in the file it becomes, so that a place in a message is the place in
// the file the person wrote.
function inOrder<T>(
  items: readonly T[],
  key: (item: T) => string,
  where: string,
): readonly T[] {
  items.forEach((item, index) => {
    const before = items[index - 1];
    if (before !== undefined && compare(key(before), key(item)) >= 0) {
      fail(`${where}[${String(index)}]`);
    }
  });
  return items;
}

function rightRef(value: unknown, where: string): RightRefEntry {
  const item = fields(value, where, ['module', 'name']);
  return {
    module: text(item['module'], `${where}.module`),
    name: text(item['name'], `${where}.name`),
  };
}

// Where evidence stands decides what it may be: a pairing takes every
// kind, with what a finding showed; that a read needs no right takes a
// finding or the document; that it does not need a certain right only a
// finding can show (ADR 0066).
type EvidenceUse = 'need' | 'none' | 'notNeeded';

const kindsFor = {
  need: ['finding', 'openapi', 'academy'],
  none: ['finding', 'openapi'],
  notNeeded: ['finding'],
} as const;

function evidence(
  value: unknown,
  where: string,
  use: EvidenceUse,
): EvidenceEntry {
  const withShows = use === 'need';
  const kind = oneOf(
    isObject(value) ? value['kind'] : undefined,
    kindsFor[use],
    `${where}.kind`,
  );
  if (kind === 'openapi') {
    fields(value, where, ['kind']);
    return { kind };
  }
  if (kind === 'academy') {
    const item = fields(value, where, ['kind', 'page']);
    return { kind, page: text(item['page'], `${where}.page`) };
  }
  const item = fields(
    value,
    where,
    withShows ? ['kind', 'id', 'version', 'shows'] : ['kind', 'id', 'version'],
  );
  const base = {
    kind,
    id: text(item['id'], `${where}.id`),
    version: text(item['version'], `${where}.version`),
  } as const;
  return withShows
    ? {
        ...base,
        shows: oneOf(
          item['shows'],
          ['necessary', 'sufficient'] as const,
          `${where}.shows`,
        ),
      }
    : base;
}

function evidenceList(
  value: unknown,
  where: string,
  use: EvidenceUse,
): readonly EvidenceEntry[] {
  return inOrder(
    list(value, where).map((item, index) =>
      evidence(item, `${where}[${String(index)}]`, use),
    ),
    evidenceKey,
    where,
  );
}

function notNeededList(
  value: unknown,
  where: string,
): readonly NotNeededEntry[] {
  return inOrder(
    list(value, where).map((item, index) => {
      const at = `${where}[${String(index)}]`;
      const entry = fields(item, at, ['right', 'evidence']);
      return {
        right: rightRef(entry['right'], `${at}.right`),
        evidence: evidenceList(
          entry['evidence'],
          `${at}.evidence`,
          'notNeeded',
        ),
      };
    }),
    (item) => refKey(item.right),
    where,
  );
}

function need(value: unknown, where: string): NeedEntry {
  const item = fields(value, where, ['rights', 'evidence'], ['without']);
  const rights = inOrder(
    list(item['rights'], `${where}.rights`).map((right, index) =>
      rightRef(right, `${where}.rights[${String(index)}]`),
    ),
    refKey,
    `${where}.rights`,
  );
  const result = {
    rights,
    ...(item['without'] === undefined
      ? {}
      : {
          without: oneOf(
            item['without'],
            ['fields', 'omitted', 'refused'] as const,
            `${where}.without`,
          ),
        }),
    evidence: evidenceList(item['evidence'], `${where}.evidence`, 'need'),
  };
  return result;
}

function operation(value: unknown, where: string): OperationRightsEntry {
  if (!isObject(value)) {
    return fail(where);
  }
  if ('needs' in value) {
    const item = fields(value, where, ['operationId', 'needs'], ['notNeeded']);
    const needs = inOrder(
      list(item['needs'], `${where}.needs`).map((entry, index) =>
        need(entry, `${where}.needs[${String(index)}]`),
      ),
      (entry) => (entry.rights[0] === undefined ? '' : refKey(entry.rights[0])),
      `${where}.needs`,
    );
    return {
      operationId: text(item['operationId'], `${where}.operationId`),
      needs,
      ...(item['notNeeded'] === undefined
        ? {}
        : {
            notNeeded: notNeededList(item['notNeeded'], `${where}.notNeeded`),
          }),
    };
  }
  if ('none' in value) {
    const item = fields(value, where, ['operationId', 'none']);
    return {
      operationId: text(item['operationId'], `${where}.operationId`),
      none: evidenceList(item['none'], `${where}.none`, 'none'),
    };
  }
  const item = fields(value, where, ['operationId', 'open'], ['notNeeded']);
  return {
    operationId: text(item['operationId'], `${where}.operationId`),
    open: text(item['open'], `${where}.open`),
    ...(item['notNeeded'] === undefined
      ? {}
      : { notNeeded: notNeededList(item['notNeeded'], `${where}.notNeeded`) }),
  };
}

function label(value: unknown, where: string): LabelEntry {
  if (isObject(value) && 'page' in value) {
    const item = fields(value, where, ['text', 'page']);
    return {
      text: text(item['text'], `${where}.text`),
      page: text(item['page'], `${where}.page`),
    };
  }
  const item = fields(value, where, ['text', 'finding', 'version']);
  return {
    text: text(item['text'], `${where}.text`),
    finding: text(item['finding'], `${where}.finding`),
    version: text(item['version'], `${where}.version`),
  };
}

function mappedRight(value: unknown, where: string): MappedRight {
  const item = fields(value, where, ['module', 'name', 'pages'], ['label']);
  const pages = list(item['pages'], `${where}.pages`, 0).map((page, index) =>
    text(page, `${where}.pages[${String(index)}]`),
  );
  return {
    module: text(item['module'], `${where}.module`),
    name: text(item['name'], `${where}.name`),
    ...(item['label'] === undefined
      ? {}
      : { label: label(item['label'], `${where}.label`) }),
    pages: inOrder(pages, (page) => page, `${where}.pages`),
  };
}

/**
 * Finds a key that an object of a JSON text holds twice.
 *
 * @param source - A text that `JSON.parse` accepted.
 * @returns The position of the second key in the text, or undefined.
 */
function repeatedKey(source: string): number | undefined {
  const objects: Set<string>[] = [];
  // Strings, with their escapes, and the marks that open and close
  // objects and arrays; a string followed by a colon is a key.
  const token = /"(?:[^"\\]|\\.)*"|[{}[\]]/g;
  const arrays: boolean[] = [];
  for (const match of source.matchAll(token)) {
    const [mark] = match;
    if (mark === '{' || mark === '[') {
      arrays.push(mark === '[');
      if (mark === '{') {
        objects.push(new Set());
      }
    } else if (mark === '}' || mark === ']') {
      if (arrays.pop() === false) {
        objects.pop();
      }
    } else if (
      arrays.at(-1) === false &&
      /^\s*:/.test(source.slice(match.index + mark.length))
    ) {
      const keys = objects.at(-1);
      const key = JSON.parse(mark) as string;
      if (keys?.has(key) === true) {
        return match.index;
      }
      keys?.add(key);
    }
  }
  return undefined;
}

/**
 * Reads the file of the mapping and checks its form and its order: every
 * list sorted as the format wants it and nothing twice, so that the file
 * reads like the facts it becomes.
 *
 * @param source - The text of `rights-mapping.json`.
 * @returns The mapping.
 * @throws {SpikeError} `DATEI` with the place of the first mistake.
 */
export function readMapping(source: string): RightsMapping {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return fail('json');
  }
  // JSON.parse keeps the last of two equal keys, so a first one would
  // stand in the file, seen by a review, without reaching the facts.
  const twice = repeatedKey(source);
  if (twice !== undefined) {
    return fail(`key[${String(twice)}]`);
  }
  const file = fields(json, 'file', ['format', 'rights', 'operations']);
  if (file['format'] !== mappingFormat) {
    return fail('format');
  }
  const rights = inOrder(
    list(file['rights'], 'rights', 0).map((item, index) =>
      mappedRight(item, `rights[${String(index)}]`),
    ),
    refKey,
    'rights',
  );
  const operations = inOrder(
    list(file['operations'], 'operations', 0).map((item, index) =>
      operation(item, `operations[${String(index)}]`),
    ),
    (item) => item.operationId,
    'operations',
  );
  return { rights, operations };
}

/**
 * Applies the mapping to the facts the refresh made: every mapped right
 * gets its label and pages, every pairing is kept. A right, an operation
 * or a page the facts do not hold and a label from a help page that the
 * page does not write right before the name of the right stop the refresh
 * before it writes, for example when the Academy changed the text of a
 * page, and so does a right that an entry names twice.
 *
 * @param mapping - The mapping from {@link readMapping}.
 * @param facts - The facts the refresh made.
 * @param facts.rights - The rights from the answer, sorted.
 * @param facts.operationIds - The IDs of the operations.
 * @param facts.academy - The help pages with their texts.
 * @returns The rights with labels and pages and the pairings.
 * @throws {SpikeError} `DATEI` with the place in the mapping.
 */
export function applyMapping(
  mapping: RightsMapping,
  facts: {
    readonly rights: readonly RightFactEntry[];
    readonly operationIds: readonly string[];
    readonly academy: readonly Pick<AcademyPageEntry, 'path' | 'text'>[];
  },
): AppliedMapping {
  const texts = new Map(facts.academy.map((page) => [page.path, page.text]));
  const known = new Set(facts.rights.map(refKey));
  const operationIds = new Set(facts.operationIds);
  const page = (path: string, where: string): string =>
    texts.get(path) ?? fail(where);
  const right = (ref: RightRefEntry, where: string): void => {
    if (!known.has(refKey(ref))) {
      fail(where);
    }
  };

  const mapped = new Map<string, MappedRight>();
  mapping.rights.forEach((item, index) => {
    const where = `rights[${String(index)}]`;
    right(item, where);
    mapped.set(refKey(item), item);
    if (item.label !== undefined && 'page' in item.label) {
      const found = page(item.label.page, `${where}.label.page`);
      if (!found.includes(`${item.label.text} (${item.name})`)) {
        fail(`${where}.label`);
      }
    }
    item.pages.forEach((path, position) => {
      page(path, `${where}.pages[${String(position)}]`);
    });
  });

  mapping.operations.forEach((entry, index) => {
    const where = `operations[${String(index)}]`;
    if (!operationIds.has(entry.operationId)) {
      fail(`${where}.operationId`);
    }
    // No right twice in an entry, needed and not needed at once.
    const seen = new Set<string>();
    const once = (ref: RightRefEntry, at: string) => {
      right(ref, at);
      if (seen.has(refKey(ref))) {
        fail(at);
      }
      seen.add(refKey(ref));
    };
    if ('needs' in entry) {
      entry.needs.forEach((item, position) => {
        const at = `${where}.needs[${String(position)}]`;
        item.rights.forEach((ref, place) => {
          once(ref, `${at}.rights[${String(place)}]`);
        });
        item.evidence.forEach((piece, place) => {
          if (piece.kind === 'academy') {
            page(piece.page, `${at}.evidence[${String(place)}].page`);
          }
        });
      });
    }
    if ('notNeeded' in entry) {
      entry.notNeeded?.forEach((item, position) => {
        once(item.right, `${where}.notNeeded[${String(position)}].right`);
      });
    }
  });

  return {
    rights: facts.rights.map((fact) => {
      const item = mapped.get(refKey(fact));
      return {
        module: fact.module,
        name: fact.name,
        kind: fact.kind,
        ...(item?.label === undefined ? {} : { label: item.label }),
        pages: item?.pages ?? [],
      };
    }),
    operationRights: mapping.operations,
  };
}
