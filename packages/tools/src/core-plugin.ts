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

/**
 * Builds the plugin of the free core, under the name of the package of the
 * server, which the catalog reserves for it. It adds every tool of the
 * core. Which of them the catalog offers decides the composition root with
 * the toolsets of the operator (`ECCLIUM_TOOLSETS`, ADR 0062): without any,
 * a server on a productive tenant offers only `ct_whoami`.
 *
 * @returns The plugin, frozen.
 * @example
 * ```ts
 * const catalog = createToolCatalog({
 *   core: createCorePlugin(),
 *   plugins: [],
 *   readOnly: true,
 * });
 * catalog.get('ct_whoami')?.origin; // 'core'
 * ```
 */
export function createCorePlugin(): Plugin {
  return Object.freeze({
    name: '@ecclium/mcp-churchtools',
    version: '0.0.0',
    register(host: PluginHost): undefined {
      host.addTool(whoamiTool);
      host.addTool(personsSearchTool);
      host.addTool(groupsSearchTool);
      return undefined;
    },
  });
}
