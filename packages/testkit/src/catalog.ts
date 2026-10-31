/**
 * The catalog of every tool of the core, with every toolset and the
 * synthetic docs index, for tests that must cover each tool, such as the
 * property tests of the redaction over the shape of every output (ADR
 * 0070). A test that walks this catalog covers a new tool from the day it
 * comes into the core.
 *
 * @packageDocumentation
 */
import {
  createToolCatalog,
  type ToolCatalog,
  toolsetNames,
} from '@ecclium/mcp-churchtools-core';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';

import { syntheticDocsIndex } from './fixtures/docs-facts.js';

/**
 * Builds the catalog of every tool of the core: all toolsets, the escape
 * hatch included, read only, without plugins.
 *
 * @returns A new catalog.
 * @example
 * ```ts
 * for (const entry of coreToolCatalog().list()) check(entry.shape.root);
 * ```
 */
export function coreToolCatalog(): ToolCatalog {
  return createToolCatalog({
    core: createCorePlugin({ docs: syntheticDocsIndex() }),
    plugins: [],
    readOnly: true,
    toolsets: new Set(toolsetNames),
  });
}
