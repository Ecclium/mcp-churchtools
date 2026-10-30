/**
 * The docs tools as the plugin of the core adds them. The plugin imports
 * only the plugin API, as a plugin of a third party must; the docs tools
 * are the one part of the core plugin that reads more, the docs index the
 * composition root loaded, so the plugin reaches it only through this
 * module (ADR 0066).
 *
 * @packageDocumentation
 */
import type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';
import type { PluginHost } from '@ecclium/mcp-churchtools-plugin-api';

import { addAcademyTools } from './academy.js';
import { addOperationTools } from './operations.js';
import { addRightTools } from './rights.js';

export type { DocsIndex } from '@ecclium/mcp-churchtools-docs-index';

/**
 * Adds the six docs tools: search and lookup of the operations, the
 * rights and the help pages of the Academy, all over the given index.
 *
 * @param host - The host of the plugin of the core.
 * @param docs - The docs index the composition root loaded.
 * @example
 * ```ts
 * if (docs !== undefined) addDocsTools(host, docs);
 * ```
 */
export function addDocsTools(host: PluginHost, docs: DocsIndex): void {
  addOperationTools(host, docs);
  addRightTools(host, docs);
  addAcademyTools(host, docs);
}
