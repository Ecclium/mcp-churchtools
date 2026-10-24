/**
 * The catalog of tools for the start over stdio: the plugin of the free
 * core and no other plugin (ADR 0024). The start builds it before the
 * server and its SDK load, so a refusal of the registry ends the start
 * with a notice while stderr still blocks.
 *
 * @packageDocumentation
 */
import {
  createToolCatalog,
  type EccliumConfig,
  type ToolCatalog,
} from '@ecclium/mcp-churchtools-core';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';

/**
 * Builds the catalog of the server over stdio from the plugin of the core.
 * With `readOnly`, write tools stay out of it. Besides `ct_whoami`, it
 * holds only the tools of the toolsets the operator turned on (ADR 0062);
 * with `persons`, the start needs the folder of the audit file (ADR 0028).
 *
 * @param config - The checked configuration; `readOnly` and `toolsets`
 *   count.
 * @returns The frozen catalog.
 * @throws {RegistryRefusal} When the registry refuses the plugin or one of
 *   its tools. The start then stops.
 * @example
 * ```ts
 * const catalog = createStdioCatalog(config);
 * catalog.has('ct_whoami'); // true
 * ```
 */
export function createStdioCatalog(
  config: Pick<EccliumConfig, 'readOnly' | 'toolsets'>,
): ToolCatalog {
  return createToolCatalog({
    core: createCorePlugin(),
    plugins: [],
    readOnly: config.readOnly,
    toolsets: new Set(config.toolsets),
  });
}
