/**
 * The registry of tools and the host plugins add their tools to (ADR 0024).
 * The free core adds its own tools first, through the same host. Every tool
 * is checked when it is added; the first refusal stops the start.
 *
 * @packageDocumentation
 */
import type {
  Plugin,
  PluginHost,
  Sensitivity,
  ToolCall,
  ToolMeta,
  ToolName,
} from '@ecclium/mcp-churchtools-plugin-api';
import type { ZodType } from 'zod';

import { toolNamePattern } from '../logger/fields.js';
import {
  checkDescription,
  descriptionBudget,
  renderDescription,
} from './description.js';
import { checkMeta } from './meta.js';
import { readFields } from './own.js';
import { pluginNamePattern, RegistryRefusal } from './refusal.js';
import {
  checkInputSchema,
  checkOutputSchema,
  type ObjectJsonSchema,
  type OutputShape,
} from './schema.js';

/** A checked tool as the pipeline runs it. */
export interface CatalogEntry {
  /** Name of the tool. */
  readonly name: ToolName;
  /** Name of the plugin that added it. */
  readonly plugin: string;
  /**
   * Whether the free core added it or another plugin. It follows from the
   * list the composition root put the plugin in, never from its name, its
   * version or the order of the plugins.
   */
  readonly origin: 'core' | 'plugin';
  /** The checked metadata, frozen. */
  readonly meta: ToolMeta;
  /** The rendered description the model reads. */
  readonly description: string;
  /** The input schema, a closed object. */
  readonly input: ZodType;
  /**
   * The input schema as the mount advertises it, derived once when the tool
   * was added, frozen.
   */
  readonly inputSchema: ObjectJsonSchema;
  /** The output schema, checked when the tool was added. */
  readonly output: ZodType;
  /** What each field of the output holds, kept when the tool was added. */
  readonly shape: OutputShape;
  /**
   * Runs the tool. It calls the function the tool had when it was added,
   * without `this`, so the tool cannot swap it later.
   */
  readonly execute: (call: ToolCall<unknown>) => Promise<unknown>;
}

/** The frozen list of checked tools. */
export interface ToolCatalog {
  /** Every tool, sorted by name, frozen. */
  readonly list: () => readonly CatalogEntry[];
  /** The tool of a name, or `undefined` when there is none. */
  readonly get: (name: string) => CatalogEntry | undefined;
  /**
   * Whether a tool of a name exists, as the audit sink asks. A property,
   * not a method, so it can be passed on without `this`.
   */
  readonly has: (name: string) => boolean;
}

/** What the composition root hands to {@link createToolCatalog}. */
export interface CatalogOptions {
  /**
   * The plugin of the free core. It registers first, and its tools have the
   * origin `core`. It is required, so that no composition root can leave
   * the core out and let a plugin take the names of its tools.
   */
  readonly core: Plugin;
  /**
   * The other plugins, in the order they register. Their tools have the
   * origin `plugin`, and none of them may carry the name reserved for the
   * core.
   */
  readonly plugins: readonly Plugin[];
  /** Whether write tools stay out of the catalog. */
  readonly readOnly: boolean;
}

// The name of the package of the core. A plugin under this name would pass
// for the core wherever a log, an audit line or a refusal names the plugin.
const reservedPluginName = '@ecclium/mcp-churchtools';

const rank: Readonly<Record<Sensitivity, number>> = Object.freeze({
  __proto__: null,
  none: 0,
  personal: 1,
  special: 2,
});

const isVersion = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e) return false;
  }
  return true;
};

const toolKeys = ['name', 'meta', 'description', 'input', 'output', 'execute'];

// Checks one tool and makes its entry, or throws the refusal.
const checkTool = (
  tool: unknown,
  plugin: string,
  origin: CatalogEntry['origin'],
): CatalogEntry => {
  const fields = readFields(tool, toolKeys, toolKeys);
  if (fields === undefined || typeof fields.execute !== 'function') {
    throw new RegistryRefusal('tool_invalid', { plugin });
  }
  const { name } = fields;
  if (
    typeof name !== 'string' ||
    name.length > 63 ||
    !toolNamePattern.test(name) ||
    name === 'ct_unknown'
  ) {
    throw new RegistryRefusal('tool_name', { plugin });
  }
  const where = { plugin, tool: name };
  const meta = checkMeta(fields.meta);
  if (meta === undefined) throw new RegistryRefusal('tool_meta', where);
  const description = checkDescription(fields.description);
  if (description === undefined) {
    throw new RegistryRefusal('tool_description', where);
  }
  const inputSchema = checkInputSchema(fields.input);
  if (inputSchema === undefined) {
    throw new RegistryRefusal('tool_input', where);
  }
  const shape = checkOutputSchema(fields.output);
  if (shape === undefined) throw new RegistryRefusal('tool_output', where);
  if (rank[meta.sensitivity] < rank[shape.minimumSensitivity]) {
    throw new RegistryRefusal('tool_sensitivity', where);
  }
  // Every field says what it holds, so none leaves unmasked by oversight,
  // and none holds an address or an amount before the core can mask them
  // (ADR 0026).
  if (shape.unclassified > 0) {
    throw new RegistryRefusal('tool_unclassified', where);
  }
  if (shape.unmasked > 0) throw new RegistryRefusal('tool_unmasked', where);
  const run = fields.execute;
  return Object.freeze({
    __proto__: null,
    name: name as ToolName,
    plugin,
    origin,
    meta,
    description: renderDescription(description, meta.requiredRights),
    input: fields.input as ZodType,
    inputSchema,
    output: fields.output as ZodType,
    shape,
    execute: (call: ToolCall<unknown>): Promise<unknown> =>
      Reflect.apply(run, undefined, [call]) as Promise<unknown>,
  });
};

// A promise from an async register must not end as an unhandled rejection.
const settle = (result: unknown): void => {
  try {
    const then = (result as { then?: unknown }).then;
    if (typeof then === 'function') {
      Reflect.apply(then, result, [undefined, () => undefined]);
    }
  } catch {
    // The refusal follows in any case.
  }
};

// Runs the register function of one plugin with a host that is valid only
// during the call, and returns the tools it added.
const registerPlugin = (
  plugin: unknown,
  origin: CatalogEntry['origin'],
  plugins: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): { readonly name: string; readonly tools: readonly CatalogEntry[] } => {
  const fields = readFields(
    plugin,
    ['name', 'version', 'register'],
    ['name', 'version', 'register'],
  );
  const name = fields?.name;
  if (
    fields === undefined ||
    typeof name !== 'string' ||
    name.length > 214 ||
    !pluginNamePattern.test(name) ||
    !isVersion(fields.version) ||
    typeof fields.register !== 'function'
  ) {
    throw new RegistryRefusal('plugin_invalid');
  }
  // Before the check for duplicates, so that a plugin under the name of the
  // core is refused as such even when the core carries that name.
  if (origin === 'plugin' && name === reservedPluginName) {
    throw new RegistryRefusal('plugin_reserved', { plugin: name });
  }
  if (plugins.has(name)) {
    throw new RegistryRefusal('plugin_duplicate', { plugin: name });
  }
  const tools: CatalogEntry[] = [];
  let open = true;
  let refusal: RegistryRefusal | undefined;
  const addTool = (tool: unknown): void => {
    if (!open) throw new RegistryRefusal('host_revoked', { plugin: name });
    if (refusal !== undefined) throw refusal;
    try {
      const entry = checkTool(tool, name, origin);
      if (taken.has(entry.name) || tools.some((t) => t.name === entry.name)) {
        throw new RegistryRefusal('tool_duplicate', {
          plugin: name,
          tool: entry.name,
        });
      }
      tools.push(entry);
    } catch (error) {
      refusal =
        error instanceof RegistryRefusal
          ? error
          : new RegistryRefusal('tool_invalid', { plugin: name });
      throw refusal;
    }
  };
  const host: PluginHost = Object.freeze({ __proto__: null, addTool });
  let result: unknown;
  try {
    result = Reflect.apply(fields.register, plugin, [host]);
  } catch {
    throw refusal ?? new RegistryRefusal('plugin_threw', { plugin: name });
  } finally {
    open = false;
  }
  if (result !== undefined) {
    settle(result);
    throw new RegistryRefusal('plugin_async', { plugin: name });
  }
  // A plugin that caught a refusal and went on is refused all the same.
  if (refusal !== undefined) throw refusal;
  return { name, tools };
};

/**
 * Builds the catalog of tools from the plugin of the core and the other
 * plugins.
 *
 * The core registers first, then the other plugins in their order, so no
 * plugin can take the name of a tool of the core. Each plugin registers
 * synchronously with a host of its own, which is valid only while its
 * `register` runs. The tools of a plugin count only when `register`
 * returns `undefined`: all of them or none. A tool has the origin of the
 * list its plugin came in. With `readOnly`, write tools stay out of the
 * catalog. The catalog is sorted by name, compared by code units, and the
 * rendered descriptions of all its tools together may hold at most 25'000
 * code units.
 *
 * @param options - The plugin of the core, the other plugins and whether
 *   the server only reads.
 * @returns The frozen catalog.
 * @throws {RegistryRefusal} On the first plugin or tool the registry
 *   refuses, among them another plugin under the name of the core
 *   (`plugin_reserved`). The start then stops.
 * @example
 * ```ts
 * const catalog = createToolCatalog({
 *   core: corePlugin,
 *   plugins: [],
 *   readOnly: true,
 * });
 * catalog.get('ct_whoami')?.origin; // 'core'
 * ```
 */
export function createToolCatalog(options: CatalogOptions): ToolCatalog {
  const plugins = new Set<string>();
  const byName = new Map<string, CatalogEntry>();
  const register = (plugin: unknown, origin: CatalogEntry['origin']): void => {
    const { name, tools } = registerPlugin(
      plugin,
      origin,
      plugins,
      new Set(byName.keys()),
    );
    plugins.add(name);
    for (const tool of tools) byName.set(tool.name, tool);
  };
  register(options.core, 'core');
  for (const plugin of options.plugins) register(plugin, 'plugin');
  const kept = [...byName.values()].filter(
    (tool) => !options.readOnly || tool.meta.capability === 'read',
  );
  let length = 0;
  for (const tool of kept) length += tool.description.length;
  if (length > descriptionBudget) {
    throw new RegistryRefusal('description_budget');
  }
  const list = Object.freeze(kept.sort((a, b) => (a.name < b.name ? -1 : 1)));
  const index = new Map(list.map((tool) => [tool.name as string, tool]));
  return Object.freeze({
    __proto__: null,
    list: () => list,
    get: (name: string) => index.get(name),
    has: (name: string) => index.has(name),
  });
}
