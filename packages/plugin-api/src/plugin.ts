/**
 * A plugin and the host it registers with.
 *
 * @packageDocumentation
 */

import type { PromptDefinition } from './prompt.js';
import type { ToolDefinition } from './tool.js';

/**
 * Where a plugin adds what it brings. The free core adds its own tools and
 * prompts through the same host as any plugin.
 *
 * Its methods avoid the names of the registration functions of the MCP SDK,
 * such as `registerTool`: the architecture rule that keeps registration in
 * the mount recognises them by name (ADR 0024).
 */
export interface PluginHost {
  /**
   * Adds a tool. The registry of the core checks it and refuses one with
   * incomplete metadata, a combination the metadata forbid or a name that is
   * taken.
   *
   * @param tool - The tool.
   */
  addTool<Input, Output>(tool: ToolDefinition<Input, Output>): void;
  /**
   * Adds a prompt (ADR 0065). The registry of the core checks it and refuses
   * one with a field out of form, a template whose placeholders do not
   * match its arguments, a tool the catalog does not hold or a name that is
   * taken.
   *
   * @param prompt - The prompt.
   */
  addPrompt(prompt: PromptDefinition): void;
}

/**
 * An extension of Ecclium. It registers synchronously: once `register`
 * returns, the core freezes the host, and nothing can be added later.
 */
export interface Plugin {
  /** Name of the plugin, usually its npm package. */
  readonly name: string;
  /** Version of the plugin. */
  readonly version: string;
  /**
   * Adds the tools and prompts of the plugin. It returns `undefined`, not `void`, so that
   * an async function, which returns a promise, does not fit. A method or a
   * function declared on its own therefore names the return type
   * `undefined`, such as `register(host: PluginHost): undefined { … }`.
   *
   * @param host - The host to add them to, valid only during this call.
   */
  register(host: PluginHost): undefined;
}
