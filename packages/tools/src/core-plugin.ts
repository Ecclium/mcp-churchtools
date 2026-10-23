/**
 * The plugin of the free core. It adds the tools of the core through the
 * same host as any other plugin and, like a plugin of a third party,
 * imports only the plugin API and zod (ADR 0022). The composition root
 * hands it to the catalog as the core, so its tools carry the origin
 * `core`, and no other plugin may take its name.
 *
 * @packageDocumentation
 */
import type { Plugin, PluginHost } from '@ecclium/mcp-churchtools-plugin-api';

import { whoamiTool } from './base/whoami.js';
import { groupsSearchTool } from './groups/search.js';
import { personsSearchTool } from './persons/search.js';

/** What the composition root decides for the plugin of the core. */
export interface CorePluginOptions {
  /**
   * Whether `ct_persons_search` and `ct_groups_search` join the catalog. In
   * phase 1 they do only when the operator enables them, so that a server
   * on a productive tenant offers only `ct_whoami` unless someone decided
   * otherwise (`ECCLIUM_SEARCH_TOOLS`, ADR 0055).
   */
  readonly searchTools: boolean;
}

/**
 * Builds the plugin of the free core, under the name of the package of the
 * server, which the catalog reserves for it. It always adds `ct_whoami`,
 * and the two search tools only with `searchTools`.
 *
 * @param options - Whether the search tools are enabled.
 * @returns The plugin, frozen.
 * @example
 * ```ts
 * const catalog = createToolCatalog({
 *   core: createCorePlugin({ searchTools: false }),
 *   plugins: [],
 *   readOnly: true,
 * });
 * catalog.get('ct_whoami')?.origin; // 'core'
 * ```
 */
export function createCorePlugin(options: CorePluginOptions): Plugin {
  // Read once, so that a later change of the options changes no catalog.
  // Only true enables them, also for a caller without the types.
  const value: unknown = options.searchTools;
  const searchTools = value === true;
  return Object.freeze({
    name: '@ecclium/mcp-churchtools',
    version: '0.0.0',
    register(host: PluginHost): undefined {
      host.addTool(whoamiTool);
      if (searchTools) {
        host.addTool(personsSearchTool);
        host.addTool(groupsSearchTool);
      }
      return undefined;
    },
  });
}
