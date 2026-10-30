/**
 * The tools of the escape hatch as the plugin of the core adds them
 * (ADR 0067). Like the docs tools they read the docs index the
 * composition root loaded, so the plugin reaches them only through this
 * module; ChurchTools they reach only through the read API.
 *
 * @packageDocumentation
 */
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import type { PluginHost } from '@ecclium/mcp-churchtools-plugin-api';

import { addExecuteReadTool } from './execute-read.js';
import { addSearchActionsTool } from './search-actions.js';

/**
 * Adds `ct_api_search_actions` and `ct_api_execute_read`. The catalog
 * offers them only with the toolset `api`, which `all` leaves out.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * if (docs !== undefined) addApiTools(host, docs);
 * ```
 */
export function addApiTools(host: PluginHost, docs: DocsIndex): void {
  addSearchActionsTool(host, docs);
  addExecuteReadTool(host, docs);
}
