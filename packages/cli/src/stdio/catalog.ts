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
import { corePlugin } from '@ecclium/mcp-churchtools-tools';

/**
 * Builds the catalog of the server over stdio from the plugin of the core.
 * With `readOnly`, write tools stay out of it.
 *
 * @param config - The checked configuration; only `readOnly` counts.
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
  config: Pick<EccliumConfig, 'readOnly'>,
): ToolCatalog {
  return createToolCatalog({
    core: corePlugin,
    plugins: [],
    readOnly: config.readOnly,
  });
}
