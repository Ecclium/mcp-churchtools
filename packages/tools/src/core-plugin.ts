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

/**
 * The plugin of the free core, under the name of the package of the
 * server, which the catalog reserves for it.
 *
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
export const corePlugin: Plugin = {
  name: '@ecclium/mcp-churchtools',
  version: '0.0.0',
  register(host: PluginHost): undefined {
    host.addTool(whoamiTool);
    return undefined;
  },
};
