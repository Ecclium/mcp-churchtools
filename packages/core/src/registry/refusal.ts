/**
 * Why the registry refuses a plugin or a tool (ADR 0024). The start stops on
 * the first refusal: a server without the tools it should have would run
 * without anyone noticing.
 *
 * @packageDocumentation
 */
import { toolNamePattern } from '../logger/fields.js';

/** Every reason the registry gives, frozen. */
export const refusalReasons = Object.freeze([
  'plugin_invalid',
  'plugin_duplicate',
  'plugin_threw',
  'plugin_async',
  'host_revoked',
  'tool_invalid',
  'tool_name',
  'tool_duplicate',
  'tool_meta',
  'tool_description',
  'tool_input',
  'tool_output',
  'tool_sensitivity',
  'description_budget',
] as const);

/** Why the registry refuses a plugin or a tool. */
export type RefusalReason = (typeof refusalReasons)[number];

// Fixed sentences, so that no text of a plugin reaches a message.
const sentences: Readonly<Record<RefusalReason, string>> = Object.freeze({
  __proto__: null,
  plugin_invalid: 'A plugin has no valid name, version or register function.',
  plugin_duplicate: 'Two plugins have the same name.',
  plugin_threw: 'A plugin threw while it registered its tools.',
  plugin_async: 'A plugin registered its tools asynchronously.',
  host_revoked: 'A plugin added a tool after its registration had ended.',
  tool_invalid: 'A tool is not an object with the fields of a tool.',
  tool_name: 'A tool has a name that is not allowed.',
  tool_duplicate: 'Two tools have the same name.',
  tool_meta: 'A tool has incomplete or contradictory metadata.',
  tool_description:
    'A tool has a description with a missing or invalid section.',
  tool_input:
    'A tool has an input schema that is not a closed object or cannot be advertised as JSON Schema.',
  tool_output: 'A tool has an output schema the registry does not accept.',
  tool_sensitivity:
    'A tool declares a lower sensitivity than its output holds.',
  description_budget: 'The descriptions of all tools are longer than allowed.',
});

/**
 * A plugin name as npm allows it. Check the length (at most 214) before the
 * pattern runs. Never give it a flag.
 */
export const pluginNamePattern =
  /^(?:@[a-z0-9][a-z0-9._~-]{0,99}\/)?[a-z0-9][a-z0-9._~-]{0,99}$/;

const safe = (
  value: string | undefined,
  pattern: RegExp,
  maxLength: number,
): string | undefined =>
  value !== undefined && value.length <= maxLength && pattern.test(value)
    ? value
    : undefined;

/**
 * The refusal of a plugin or a tool by the registry. Its message is a fixed
 * sentence. It names plugin and tool only when their names have the form of
 * a package or a tool name, so no text of a plugin reaches a terminal.
 *
 * @example
 * ```ts
 * throw new RegistryRefusal('tool_meta', { plugin: 'example', tool: 'ct_x' });
 * ```
 */
export class RegistryRefusal extends Error {
  /** Why the registry refused. */
  readonly reason: RefusalReason;
  /** The plugin, when its name has the form of a package name. */
  readonly plugin: string | undefined;
  /** The tool, when its name has the form of a tool name. */
  readonly tool: string | undefined;

  /**
   * Makes the refusal with the fixed sentence of its reason.
   *
   * @param reason - Why the registry refused.
   * @param where - The plugin and the tool, as far as they are known.
   * @param where.plugin - Name of the plugin, kept only in the form of a
   *   package name.
   * @param where.tool - Name of the tool, kept only in the form of a tool
   *   name.
   */
  constructor(
    reason: RefusalReason,
    where: { readonly plugin?: string; readonly tool?: string } = {},
  ) {
    super(sentences[reason]);
    this.name = 'RegistryRefusal';
    this.reason = reason;
    this.plugin = safe(where.plugin, pluginNamePattern, 214);
    this.tool = safe(where.tool, toolNamePattern, 63);
  }
}
