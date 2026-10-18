/**
 * The annotations a tool carries in the list of tools. Clients build their
 * dialogs of approval on them, for example whether they ask before a call,
 * so the mount derives all four hints from the metadata of the tool, which
 * the registry checked (ADR 0024), and never takes them from a plugin.
 *
 * @packageDocumentation
 */
import type { ToolMeta } from '@ecclium/mcp-churchtools-plugin-api';
import type { ToolAnnotations } from '@modelcontextprotocol/server';

/**
 * The four hints of a tool, each one set. The names come from the
 * annotations of MCP, so a misspelt hint does not compile.
 */
export type ToolHints = Readonly<
  Required<
    Pick<
      ToolAnnotations,
      'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'
    >
  >
>;

// Every tool reaches ChurchTools, whose content people other than the user
// write, and free text from there can carry an injection (threat model,
// T7). That is an open world, and true is also what the specification
// assumes when the hint is missing.
const openWorld = true;

// A tool that only reads changes nothing, so it destroys nothing, and the
// same call again has no further effect.
const readHints: ToolHints = Object.freeze({
  __proto__: null,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

// No write counts as idempotent, whatever guards it against a replay: a
// client must not repeat a write on its own because a hint allowed it.
// Only a write that can be undone counts as not destructive.
const reversibleWriteHints: ToolHints = Object.freeze({
  __proto__: null,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: openWorld,
});

const destructiveWriteHints: ToolHints = Object.freeze({
  __proto__: null,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: openWorld,
});

/**
 * Derives the four hints of a tool from its metadata. A reading tool has
 * `readOnlyHint` true, `destructiveHint` false and `idempotentHint` true.
 * A writing tool has `readOnlyHint` and `idempotentHint` false and
 * `destructiveHint` true, unless it can be undone (`reversible: 'yes'`).
 * `openWorldHint` is true for every tool.
 *
 * A value outside the types counts as the more cautious one: whatever is
 * not exactly `read` as a write, and whatever is not exactly `'yes'` as a
 * write that cannot be undone. A plugin that slipped past the registry
 * then makes the client ask more, not less. It never throws, because it
 * only reads two fields of the frozen copy the registry keeps.
 *
 * @param meta - The metadata of the tool, as the registry checked it.
 * @returns The hints, frozen and without prototype. Tools with the same
 *   hints share one object; the SDK copies a result before it changes
 *   one, so the object stays as it is.
 * @example
 * ```ts
 * deriveAnnotations(entry.meta);
 * // { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
 * //   openWorldHint: true }
 * ```
 */
export function deriveAnnotations(meta: ToolMeta): ToolHints {
  if (meta.capability === 'read') return readHints;
  return meta.reversible === 'yes'
    ? reversibleWriteHints
    : destructiveWriteHints;
}
