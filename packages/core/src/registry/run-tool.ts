/**
 * The facts of a tool that the engine of a run needs before the first read
 * (ADR 0033): whether it is a read tool a routine may rely on, which
 * parameters it takes, where its entries stand and whether it has pages.
 *
 * Where it stands in a run: when the engine prepares a routine, before it
 * reads anything. It checks each input against these facts, so that a
 * routine with a tool that is not stable, a parameter the tool does not
 * know or a field of an entry that does not exist never starts.
 *
 * Only plain names and switches leave the core, never a schema of the
 * tool, which a caller could widen or call.
 *
 * @packageDocumentation
 */
import type { ToolMeta } from '@ecclium/mcp-churchtools-plugin-api';

import type { ToolCatalog } from './registry.js';
import type { ShapeNode } from './schema.js';

/** What the engine of a run learns of one tool. */
export interface RunToolFacts {
  /** Whether the tool reads or writes. */
  readonly capability: ToolMeta['capability'];
  /** Whether a routine may rely on the tool (ADR 0064). */
  readonly routineStable: boolean;
  /** Whether the tool may run without a person, and how. */
  readonly unattended: ToolMeta['unattended'];
  /** The names of its parameters, sorted. */
  readonly params: readonly string[];
  /**
   * The field of the top level of the result that holds its entries, or
   * undefined when a result is one entry, such as one page of the wiki.
   */
  readonly list?: string;
  /**
   * The fields of one entry that hold a single value, sorted: what an
   * input of a routine may name with `{ field }`.
   */
  readonly entryFields: readonly string[];
  /**
   * Whether the tool reads in pages: it takes `page` and its result says
   * with `more` that a further page follows.
   */
  readonly paged: boolean;
}

type ObjectNode = ShapeNode & { readonly kind: 'object' };

// Names of fields and parameters are plain ASCII, so the order of code
// units is the order of their letters.
const sorted = (names: Iterable<string>): readonly string[] =>
  Object.freeze([...names].sort());

// The fields of an object that hold a single value.
const leavesOf = (node: ShapeNode): readonly string[] =>
  node.kind === 'object'
    ? sorted(
        Object.entries(node.fields)
          .filter(([, field]) => field.kind === 'leaf')
          .map(([name]) => name),
      )
    : Object.freeze([]);

// The one field of the top level that is a list, with the shape of an
// entry, as the pipeline counts entries (pipeline/run-read.ts).
const listOf = (root: ObjectNode): readonly [string, ShapeNode] | undefined => {
  const lists = Object.entries(root.fields).flatMap(([name, node]) =>
    node.kind === 'array' ? [[name, node.element] as const] : [],
  );
  return lists.length === 1 ? lists[0] : undefined;
};

/**
 * Tells the engine of a run what it needs to know of a tool.
 *
 * @param catalog - The catalog of the server or the runner.
 * @param name - The name of the tool, as a routine names it.
 * @returns The facts, frozen, or undefined when the catalog has no such
 *   tool.
 * @example
 * ```ts
 * describeRunTool(catalog, 'ct_events_list');
 * // { capability: 'read', routineStable: true, unattended: 'policy',
 * //   params: ['from', 'page', 'to'], list: 'events', entryFields: [...], paged: true }
 * ```
 */
export function describeRunTool(
  catalog: ToolCatalog,
  name: string,
): RunToolFacts | undefined {
  const entry = catalog.get(name);
  if (entry === undefined) return undefined;
  const properties = entry.inputSchema['properties'];
  const params =
    typeof properties === 'object' && properties !== null
      ? sorted(Object.keys(properties))
      : Object.freeze([]);
  const root = entry.shape.root;
  const list = listOf(root);
  const more = root.fields['more'];
  return Object.freeze({
    capability: entry.meta.capability,
    routineStable: entry.meta.routineStable,
    unattended: entry.meta.unattended,
    params,
    ...(list === undefined ? {} : { list: list[0] }),
    entryFields: leavesOf(list === undefined ? root : list[1]),
    paged:
      params.includes('page') &&
      more?.kind === 'leaf' &&
      more.types.includes('boolean'),
  });
}
