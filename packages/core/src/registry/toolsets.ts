/**
 * The toolsets an operator turns on with `ECCLIUM_TOOLSETS` (ADR 0062). A
 * toolset groups the areas of tools that belong together, and the catalog
 * offers a tool only when its area is always on or its toolset is.
 *
 * @packageDocumentation
 */
import type { ToolDomain } from '@ecclium/mcp-churchtools-plugin-api';

/** The names of the toolsets, frozen, in the order the reference lists them. */
export const toolsetNames = Object.freeze([
  'persons',
  'events',
  'calendars',
  'wiki',
  'songs',
  'docs',
] as const);

/** The name of a toolset. */
export type ToolsetName = (typeof toolsetNames)[number];

// The toolset of each area. `base` is always on, so that ct_whoami is there
// without any setting. The docs tools read only the index of the
// documentation and form the toolset `docs` (ADR 0066). The generic API
// tools have no toolset yet: until an ADR gives them one, the catalog
// offers none of their tools.
const toolsetOfDomain: Readonly<
  Record<ToolDomain, ToolsetName | 'base' | undefined>
> = Object.freeze({
  __proto__: null,
  base: 'base',
  persons: 'persons',
  groups: 'persons',
  events: 'events',
  services: 'events',
  calendars: 'calendars',
  appointments: 'calendars',
  resources: 'calendars',
  bookings: 'calendars',
  wiki: 'wiki',
  songs: 'songs',
  docs: 'docs',
  api: undefined,
});

/**
 * Tells which toolset offers the tools of an area.
 *
 * @param domain - The area from the metadata of a tool.
 * @returns The toolset, `base` for the area that is always on, or
 *   `undefined` for an area no toolset offers yet.
 * @example
 * ```ts
 * toolsetOf('groups'); // 'persons'
 * toolsetOf('base'); // 'base'
 * ```
 */
export function toolsetOf(
  domain: ToolDomain,
): ToolsetName | 'base' | undefined {
  return Object.hasOwn(toolsetOfDomain, domain)
    ? toolsetOfDomain[domain]
    : undefined;
}

/**
 * Tells whether a value is the name of a toolset.
 *
 * @param value - Any value.
 * @returns Whether it is one of {@link toolsetNames}.
 * @example
 * ```ts
 * isToolsetName('wiki'); // true
 * isToolsetName('all'); // false
 * ```
 */
export function isToolsetName(value: unknown): value is ToolsetName {
  return (toolsetNames as readonly unknown[]).includes(value);
}
