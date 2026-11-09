/**
 * What the pipeline does in addition for a read of a run of a routine
 * (ADR 0033): it keeps at most as many entries as the input of the routine
 * may pass on, and it tells the run the name of each person its model sees.
 *
 * Where it stands in a run: in the pipeline, between `validateOutput` and
 * `redact` for the entries, and after `redact` for the names. Only the
 * pipeline may change a value it marks as redacted, so the entries are cut
 * here and never in the engine. Only the pipeline turns IDs into
 * pseudonyms and back (ADR 0069), so the list of names goes from the
 * pseudonym, or in the level `standard` from the ID, to the name, and the
 * engine only looks a name up. Names come in the level `standard`, never
 * `off`, because the readers of a report are not the persons who may see
 * the data in ChurchTools.
 *
 * @packageDocumentation
 */
import type { ShapeNode } from '../registry/index.js';
import { redact } from './stages.js';

type ObjectNode = ShapeNode & { readonly kind: 'object' };

/**
 * The field of the top level of a result that holds its entries: the one
 * field that is a list. A result with no list or with several counts as
 * one entry, such as the text of one page of the wiki.
 *
 * @param root - The kept shape of the result.
 * @returns The name of the field, or undefined.
 * @example
 * ```ts
 * entryListOf(shapeOfEventsList); // 'events'
 * ```
 */
export function entryListOf(root: ObjectNode): string | undefined {
  const lists = Object.entries(root.fields).filter(
    ([, node]) => node.kind === 'array',
  );
  const [only] = lists;
  return lists.length === 1 && only !== undefined ? only[0] : undefined;
}

/** A result with at most so many entries, and what the cut did. */
export interface CutResult {
  /** The result, the same object when nothing was cut. */
  readonly data: Readonly<Record<string, unknown>>;
  /** How many entries it passes on. */
  readonly entries: number;
  /** Whether more entries follow: on a further page, or cut here. */
  readonly more: boolean;
}

// Whether the result has a field `more` of its own, as the read tools with
// pages declare it: true when a further page follows.
const hasMore = (root: ObjectNode): boolean => {
  const node = root.fields['more'];
  return node?.kind === 'leaf' && node.types.includes('boolean');
};

/**
 * Keeps at most `maxEntries` entries of a checked result. A result that
 * holds more loses the rest, and its field `more`, if it has one, says
 * `true`, so that the model knows the list goes on.
 *
 * @param data - The result as the output schema parsed it.
 * @param root - Its kept shape.
 * @param maxEntries - The most entries to keep, from 1.
 * @returns The result, the number of entries and whether more follow.
 * @example
 * ```ts
 * cutEntries({ events: [a, b, c], more: false }, root, 2);
 * // { data: { events: [a, b], more: true }, entries: 2, more: true }
 * ```
 */
export function cutEntries(
  data: Readonly<Record<string, unknown>>,
  root: ObjectNode,
  maxEntries: number,
): CutResult {
  const more = hasMore(root) && data['more'] === true;
  const list = entryListOf(root);
  if (list === undefined) return { data, entries: 1, more };
  const entries = data[list];
  if (!Array.isArray(entries)) return { data, entries: 0, more };
  if (entries.length <= maxEntries) {
    return { data, entries: entries.length, more };
  }
  const copy: Record<string, unknown> = {
    ...data,
    [list]: Object.freeze(entries.slice(0, maxEntries)),
  };
  if (hasMore(root)) copy['more'] = true;
  return { data: Object.freeze(copy), entries: maxEntries, more: true };
}

// Adds a name, never over a name that is there with one that is empty.
const addName = (
  names: Map<string, string>,
  key: string,
  name: string,
): void => {
  if (name !== '' || !names.has(key)) names.set(key, name);
};

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

// The fields of an object that are leaves of one class.
const fieldsOf = (node: ObjectNode, dataClass: string): readonly string[] =>
  Object.entries(node.fields)
    .filter(
      ([, field]) => field.kind === 'leaf' && field.dataClass === dataClass,
    )
    .map(([key]) => key);

// Walks the raw result and its copy in the level standard side by side.
const walk = (
  raw: unknown,
  shown: unknown,
  node: ShapeNode,
  keyOf: (id: number) => string,
  names: Map<string, string>,
): void => {
  if (raw === null || raw === undefined) return;
  switch (node.kind) {
    case 'leaf':
      // An ID of a person outside an object with its name, such as in a
      // list of IDs: known to the run, but without a name.
      if (node.dataClass === 'personId' && typeof raw === 'number') {
        addName(names, keyOf(raw), '');
      }
      return;
    case 'array':
      (raw as readonly unknown[]).forEach((item, index) => {
        walk(
          item,
          (shown as readonly unknown[])[index],
          node.element,
          keyOf,
          names,
        );
      });
      return;
    case 'tuple':
      node.items.forEach((item, index) => {
        walk(
          (raw as readonly unknown[])[index],
          (shown as readonly unknown[])[index],
          item,
          keyOf,
          names,
        );
      });
      return;
    case 'object': {
      const record = raw as Readonly<Record<string, unknown>>;
      const copy = shown as Readonly<Record<string, unknown>>;
      // The name belongs to the person only when the object names exactly
      // one person; with two, neither name could be told apart.
      const ids = fieldsOf(node, 'personId');
      const [idField] = ids;
      const id = idField === undefined ? undefined : record[idField];
      if (ids.length === 1 && typeof id === 'number') {
        const name = [
          ...fieldsOf(node, 'name.first'),
          ...fieldsOf(node, 'name.last'),
        ]
          .map((key) => textOf(copy[key]))
          .filter((part) => part !== '')
          .join(' ');
        addName(names, keyOf(id), name);
      }
      for (const [key, field] of Object.entries(node.fields)) {
        // The ID beside its name is in already.
        if (ids.length === 1 && key === idField) continue;
        walk(record[key], copy[key], field, keyOf, names);
      }
    }
  }
};

/**
 * The names of the persons a result names, by what the model sees of each:
 * the pseudonym in the level `strict`, the ID as text in `standard`. A
 * name is first name and last name as the level `standard` shows them,
 * from the object that names exactly this one person; a person without one
 * maps to an empty text.
 *
 * @param data - The result as the output schema parsed it, with IDs.
 * @param root - Its kept shape.
 * @param keyOf - What the model sees of an ID.
 * @returns The names, frozen, without a prototype.
 * @throws {TypeError} Whatever `keyOf` throws.
 * @example
 * ```ts
 * personNamesOf({ person: { personId: 12, firstName: 'Max', lastName: 'Muster' } }, root, String);
 * // { '12': 'Max Muster' }
 * ```
 */
export function personNamesOf(
  data: Readonly<Record<string, unknown>>,
  root: ObjectNode,
  keyOf: (id: number) => string,
): Readonly<Record<string, string>> {
  const names = new Map<string, string>();
  walk(data, redact(data, root, 'standard'), root, keyOf, names);
  const record = Object.create(null) as Record<string, string>;
  for (const [key, name] of names) record[key] = name;
  return Object.freeze(record);
}
