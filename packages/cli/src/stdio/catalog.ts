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
import {
  type DocsIndex,
  readDocsIndex,
} from '@ecclium/mcp-churchtools-docs-index';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';

/** Replacements for tests. */
export interface StdioCatalogOptions {
  /**
   * Reads the docs index, by default the built file of the package
   * `docs-index`. Tests hand in an index from synthetic facts, because
   * tests never use a built file (ADR 0022).
   */
  readonly readDocs?: () => DocsIndex;
}

/**
 * Builds the catalog of the server over stdio from the plugin of the core.
 * With `readOnly`, write tools stay out of it. Besides `ct_whoami`, it
 * holds only the tools of the toolsets the operator turned on (ADR 0062);
 * with `persons`, the start needs the folder of the audit file (ADR 0028).
 *
 * The docs index is read only with the toolset `docs`, once per process
 * (ADR 0066). Reading and checking it takes about a second and tens of
 * MiB, and a client starts the server often, also when no tool is called.
 *
 * @param config - The checked configuration; `readOnly` and `toolsets`
 *   count.
 * @param options - Replacements for tests.
 * @returns The frozen catalog.
 * @throws {DocsIndexError} When `docs` is on and the docs index is missing
 *   or breaks a rule. The start then stops rather than leave the docs
 *   tools out without a word.
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
  options: StdioCatalogOptions = {},
): ToolCatalog {
  const { readDocs = () => readDocsIndex() } = options;
  const docs = config.toolsets.includes('docs') ? readDocs() : undefined;
  return createToolCatalog({
    core: createCorePlugin(docs === undefined ? {} : { docs }),
    plugins: [],
    readOnly: config.readOnly,
    toolsets: new Set(config.toolsets),
  });
}
