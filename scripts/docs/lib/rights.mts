/**
 * Takes the facts about the rights from the answer of
 * `GET /api/permissions/global`, in the format `ecclium.docs.rights.v1`
 * of the docs index: per right its module, its name and the kind of its
 * value, never the value (ADR 0027, ADR 0066). The answer names every
 * right the instance shows to the account, a right without a value as
 * `false` or an empty list (F30, D8), so the kind is known for each.
 *
 * Rows that `churchdb` lists for rights of groups stay as the answer
 * names them. Only two of them are shown to mirror a right of
 * `churchgroup`, and `ct_whoami` shows them the same way. Which module an
 * operation needs, the mapping of operations to rights says, with its
 * evidence (decided on 29.10.2026, ADR 0066).
 *
 * @packageDocumentation
 */
import { SpikeError } from '../../spike/lib/errors.mts';
import { isObject } from '../../spike/lib/spec.mts';

/** One right of the format, with its fields in their order. */
export interface RightFactEntry {
  readonly module: string;
  readonly name: string;
  readonly kind: 'boolean' | 'list';
  readonly pages: readonly string[];
}

/** The rights of the answer and how many names stayed out. */
export interface RightFacts {
  /** The entries of `rights.json`, sorted by module and name. */
  readonly entries: readonly RightFactEntry[];
  /** Names that are not plain words and so may be a value of the instance. */
  readonly skipped: number;
}

// Every name of a module F30 saw is one lower-case word, every name of a
// right lower-case words, parted by a single space or, as in
// `push/pull archive` of ChurchTools 3.138, a slash. A name of another
// form could carry a value of the instance, such as a name it chose, so
// it stays out and is only counted.
const moduleName = /^[a-z][a-z0-9]{0,31}$/;
const rightName = /^[a-z]+(?:[ /][a-z]+)*$/;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Takes module, name and kind of every right from the answer.
 *
 * @param body - The parsed answer of `GET /api/permissions/global`.
 * @returns The entries and the number of names left out.
 * @throws {SpikeError} If the answer has another form, such as a value
 *   that is neither a truth value nor a list.
 */
export function rightFacts(body: unknown): RightFacts {
  const data = isObject(body) ? body['data'] : undefined;
  if (!isObject(data)) {
    throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', 'rights.data');
  }
  const entries: RightFactEntry[] = [];
  let skipped = 0;
  Object.keys(data)
    .sort(compare)
    .forEach((module, moduleIndex) => {
      const rights = data[module];
      if (!isObject(rights)) {
        throw new SpikeError(
          'ANTWORT_UNGUELTIG',
          'quelleUngueltig',
          `rights.data[${String(moduleIndex)}]`,
        );
      }
      for (const [rightIndex, name] of Object.keys(rights)
        .sort(compare)
        .entries()) {
        const value = rights[name];
        const kind =
          typeof value === 'boolean'
            ? 'boolean'
            : Array.isArray(value)
              ? 'list'
              : undefined;
        if (kind === undefined) {
          throw new SpikeError(
            'ANTWORT_UNGUELTIG',
            'quelleUngueltig',
            `rights.data[${String(moduleIndex)}][${String(rightIndex)}]`,
          );
        }
        if (
          !moduleName.test(module) ||
          name.length > 64 ||
          !rightName.test(name)
        ) {
          skipped += 1;
          continue;
        }
        entries.push({ module, name, kind, pages: [] });
      }
    });
  return { entries, skipped };
}
