/**
 * The registry of tools and prompts and the host plugins add them to (ADR
 * 0024, ADR 0065). The free core adds its own first, through the same host.
 * Every tool and every prompt is checked when it is added; the first
 * refusal stops the start.
 *
 * @packageDocumentation
 */
import type {
  Plugin,
  PluginHost,
  RightRef,
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
  perOperation,
  renderDescription,
} from './description.js';
import { checkMeta } from './meta.js';
import { readFields } from './own.js';
import { checkPrompt, type PromptEntry } from './prompt.js';
import { pluginNamePattern, RegistryRefusal } from './refusal.js';
import {
  checkInputSchema,
  checkOutputSchema,
  type ObjectJsonSchema,
  type OutputShape,
} from './schema.js';
import { isToolsetName, toolsetOf, type ToolsetName } from './toolsets.js';

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
   * Whether the pipeline treats the tool like one with the sensitivity
   * special: its result leaves only with its line in the audit file, and
   * every call counts against the read budget (ADR 0028, ADR 0063). True for
   * a tool with the sensitivity special and for one whose output names
   * persons outside the area base (ADR 0064). Derived from the output, so a
   * tool cannot forget it; `unattended` stays as the tool declares it.
   */
  readonly asSpecial: boolean;
  /**
   * Runs the tool. It calls the function the tool had when it was added,
   * without `this`, so the tool cannot swap it later.
   */
  readonly execute: (call: ToolCall<unknown>) => Promise<unknown>;
}

/** The frozen list of checked tools and of the prompts that rely on them. */
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
  /**
   * Every prompt the catalog offers, sorted by name, frozen: the prompts
   * whose tools it all offers (ADR 0065).
   */
  readonly prompts: () => readonly PromptEntry[];
  /** The offered prompt of a name, or `undefined` when there is none. */
  readonly prompt: (name: string) => PromptEntry | undefined;
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
  /**
   * The toolsets the operator turned on (ADR 0062). The catalog keeps a
   * tool only when its area is always on or belongs to one of them, for
   * the tools of the core and of plugins alike. Without the option only the
   * area that is always on stays, the safe side for a composition root that
   * forgets it. Every tool is checked before, also one that stays out.
   */
  readonly toolsets?: ReadonlySet<ToolsetName>;
}

// A copy of the toolsets of its own, so that a later change of the set
// changes no catalog, and with a name that is not a toolset refused.
const readToolsets = (value: unknown): ReadonlySet<string> => {
  if (value === undefined) return new Set();
  if (!(value instanceof Set)) throw new TypeError('The toolsets are no set.');
  const names = [...(value as Set<unknown>)];
  if (!names.every(isToolsetName)) {
    throw new TypeError('A toolset is unknown.');
  }
  return new Set<string>(names);
};

// Whether the catalog offers a tool of this area.
const offered = (
  tool: CatalogEntry,
  toolsets: ReadonlySet<string>,
): boolean => {
  const toolset = toolsetOf(tool.meta.domain);
  return toolset === 'base' || (toolset !== undefined && toolsets.has(toolset));
};

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

// The rights the description names. A tool of the sensitivity special in
// the area api may read any operation of the escape hatch, so without
// rights of its own its line names those of the operation, not none
// (ADR 0067). Only such a tool may read the escape hatch at all.
const rightsLine = (
  meta: ToolMeta,
): readonly RightRef[] | typeof perOperation =>
  meta.domain === 'api' &&
  meta.sensitivity === 'special' &&
  meta.requiredRights.length === 0
    ? perOperation
    : meta.requiredRights;

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
  // The area base is always on, so a tool of a plugin there would pass
  // every choice of toolsets (ADR 0062). Checked last, so that every other
  // refusal of such a tool stays as it was.
  if (origin === 'plugin' && meta.domain === 'base') {
    throw new RegistryRefusal('tool_domain_reserved', where);
  }
  const run = fields.execute;
  // A name of another person counts like special data for the audit file
  // and the read budget, also in a tool of the sensitivity personal. Only
  // the core may use the area base, where ct_whoami names the account
  // itself (ADR 0064).
  const asSpecial =
    meta.sensitivity === 'special' ||
    (shape.namesPersons && meta.domain !== 'base');
  return Object.freeze({
    __proto__: null,
    name: name as ToolName,
    plugin,
    origin,
    meta,
    description: renderDescription(description, rightsLine(meta)),
    input: fields.input as ZodType,
    inputSchema,
    output: fields.output as ZodType,
    shape,
    asSpecial,
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

// What one plugin added.
interface Registered {
  readonly name: string;
  readonly tools: readonly CatalogEntry[];
  readonly prompts: readonly PromptEntry[];
}

// Runs the register function of one plugin with a host that is valid only
// during the call, and returns the tools and prompts it added.
const registerPlugin = (
  plugin: unknown,
  origin: CatalogEntry['origin'],
  plugins: ReadonlySet<string>,
  taken: ReadonlySet<string>,
  takenPrompts: ReadonlySet<string>,
): Registered => {
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
  const prompts: PromptEntry[] = [];
  let open = true;
  let refusal: RegistryRefusal | undefined;
  // Adds one checked entry, or keeps the refusal, so that a plugin that
  // catches it and goes on is refused all the same.
  const add = (
    fallback: 'tool_invalid' | 'prompt_invalid',
    run: () => void,
  ) => {
    if (!open) throw new RegistryRefusal('host_revoked', { plugin: name });
    if (refusal !== undefined) throw refusal;
    try {
      run();
    } catch (error) {
      refusal =
        error instanceof RegistryRefusal
          ? error
          : new RegistryRefusal(fallback, { plugin: name });
      throw refusal;
    }
  };
  const addTool = (tool: unknown): void => {
    add('tool_invalid', () => {
      const entry = checkTool(tool, name, origin);
      if (taken.has(entry.name) || tools.some((t) => t.name === entry.name)) {
        throw new RegistryRefusal('tool_duplicate', {
          plugin: name,
          tool: entry.name,
        });
      }
      tools.push(entry);
    });
  };
  const addPrompt = (prompt: unknown): void => {
    add('prompt_invalid', () => {
      const entry = checkPrompt(prompt, name, origin);
      if (
        takenPrompts.has(entry.name) ||
        prompts.some((p) => p.name === entry.name)
      ) {
        throw new RegistryRefusal('prompt_duplicate', {
          plugin: name,
          prompt: entry.name,
        });
      }
      prompts.push(entry);
    });
  };
  const host: PluginHost = Object.freeze({
    __proto__: null,
    addTool,
    addPrompt,
  });
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
  return { name, tools, prompts };
};

/**
 * Builds the catalog of tools and prompts from the plugin of the core and
 * the other plugins.
 *
 * The core registers first, then the other plugins in their order, so no
 * plugin can take the name of a tool of the core. Each plugin registers
 * synchronously with a host of its own, which is valid only while its
 * `register` runs. The tools of a plugin count only when `register`
 * returns `undefined`: all of them or none. A tool has the origin of the
 * list its plugin came in. With `readOnly`, write tools stay out of the
 * catalog. The catalog is sorted by name, compared by code units, and the
 * rendered descriptions of all its tools together may hold at most 25'000
 * code units. Every tool a prompt relies on must have been added, also one
 * the catalog then leaves out; the catalog offers a prompt only when it
 * offers every one of its tools, so the prompts follow the toolsets
 * (ADR 0065).
 *
 * @param options - The plugin of the core, the other plugins and whether
 *   the server only reads.
 * @returns The frozen catalog.
 * @throws {RegistryRefusal} On the first plugin, tool or prompt the
 *   registry refuses, among them another plugin under the name of the core
 *   (`plugin_reserved`) and a prompt that relies on a tool no plugin added
 *   (`prompt_tools`). The start then stops.
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
  const toolsets = readToolsets(options.toolsets);
  const plugins = new Set<string>();
  const byName = new Map<string, CatalogEntry>();
  const promptsByName = new Map<string, PromptEntry>();
  const register = (plugin: unknown, origin: CatalogEntry['origin']): void => {
    const { name, tools, prompts } = registerPlugin(
      plugin,
      origin,
      plugins,
      new Set(byName.keys()),
      new Set(promptsByName.keys()),
    );
    plugins.add(name);
    for (const tool of tools) byName.set(tool.name, tool);
    for (const prompt of prompts) promptsByName.set(prompt.name, prompt);
  };
  register(options.core, 'core');
  for (const plugin of options.plugins) register(plugin, 'plugin');
  const kept = [...byName.values()].filter(
    (tool) =>
      (!options.readOnly || tool.meta.capability === 'read') &&
      offered(tool, toolsets),
  );
  let length = 0;
  for (const tool of kept) length += tool.description.length;
  if (length > descriptionBudget) {
    throw new RegistryRefusal('description_budget');
  }
  const list = Object.freeze(kept.sort((a, b) => (a.name < b.name ? -1 : 1)));
  const index = new Map(list.map((tool) => [tool.name as string, tool]));
  // A tool a prompt relies on that no plugin added is a mistake of the
  // plugin, refused like a tool out of form. One the catalog leaves out,
  // because of the toolsets or because it writes, leaves the prompt out.
  for (const prompt of promptsByName.values()) {
    if (!prompt.tools.every((tool) => byName.has(tool))) {
      throw new RegistryRefusal('prompt_tools', {
        plugin: prompt.plugin,
        prompt: prompt.name,
      });
    }
  }
  const prompts = Object.freeze(
    [...promptsByName.values()]
      .filter((prompt) => prompt.tools.every((tool) => index.has(tool)))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  );
  const promptIndex = new Map(prompts.map((prompt) => [prompt.name, prompt]));
  return Object.freeze({
    __proto__: null,
    list: () => list,
    get: (name: string) => index.get(name),
    has: (name: string) => index.has(name),
    prompts: () => prompts,
    prompt: (name: string) => promptIndex.get(name),
  });
}
