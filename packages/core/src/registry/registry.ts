/**
 * The registry of tools and the host plugins add their tools to (ADR 0024).
 * The free core adds its own tools through the same host. Every tool is
 * checked when it is added; the first refusal stops the start.
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
  type OutputShape,
} from './schema.js';

/** A checked tool as the pipeline runs it. */
export interface CatalogEntry {
  /** Name of the tool. */
  readonly name: ToolName;
  /** Name of the plugin that added it. */
  readonly plugin: string;
  /** The checked metadata, frozen. */
  readonly meta: ToolMeta;
  /** The rendered description the model reads. */
  readonly description: string;
  /** The input schema, a closed object. */
  readonly input: ZodType;
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
  /**
   * Lists the tools.
   *
   * @returns Every tool, sorted by name, frozen.
   */
  list(): readonly CatalogEntry[];
  /**
   * Finds a tool.
   *
   * @param name - Any name.
   * @returns The tool, or `undefined` when there is none of this name.
   */
  get(name: string): CatalogEntry | undefined;
  /**
   * Tells whether a tool exists, as the audit sink asks.
   *
   * @param name - Any name.
   * @returns Whether the catalog has a tool of this name.
   */
  has(name: string): boolean;
}

/** What the composition root hands to {@link createToolCatalog}. */
export interface CatalogOptions {
  /** The plugins, the free core first. */
  readonly plugins: readonly Plugin[];
  /** Whether write tools stay out of the catalog. */
  readonly readOnly: boolean;
}

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
const checkTool = (tool: unknown, plugin: string): CatalogEntry => {
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
  if (!checkInputSchema(fields.input)) {
    throw new RegistryRefusal('tool_input', where);
  }
  const shape = checkOutputSchema(fields.output);
  if (shape === undefined) throw new RegistryRefusal('tool_output', where);
  if (rank[meta.sensitivity] < rank[shape.minimumSensitivity]) {
    throw new RegistryRefusal('tool_sensitivity', where);
  }
  const run = fields.execute;
  return Object.freeze({
    __proto__: null,
    name: name as ToolName,
    plugin,
    meta,
    description: renderDescription(description, meta.requiredRights),
    input: fields.input as ZodType,
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
      const entry = checkTool(tool, name);
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
 * Builds the catalog of tools from the plugins.
 *
 * Each plugin registers synchronously with a host of its own, which is
 * valid only while its `register` runs. The tools of a plugin count only
 * when `register` returns `undefined`: all of them or none. With
 * `readOnly`, write tools stay out of the catalog. The catalog is sorted by
 * name, compared by code units, and the rendered descriptions of all its
 * tools together may hold at most 25'000 code units.
 *
 * @param options - The plugins and whether the server only reads.
 * @returns The frozen catalog.
 * @throws {RegistryRefusal} On the first plugin or tool the registry
 *   refuses. The start then stops.
 * @example
 * ```ts
 * const catalog = createToolCatalog({ plugins: [corePlugin], readOnly: true });
 * catalog.has('ct_whoami'); // true
 * ```
 */
export function createToolCatalog(options: CatalogOptions): ToolCatalog {
  const plugins = new Set<string>();
  const byName = new Map<string, CatalogEntry>();
  for (const plugin of options.plugins) {
    const { name, tools } = registerPlugin(
      plugin,
      plugins,
      new Set(byName.keys()),
    );
    plugins.add(name);
    for (const tool of tools) byName.set(tool.name, tool);
  }
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
