/**
 * The catalog of tools of a command for the operator, by the kind of the
 * configuration it loaded (ADR 0036): over stdio the catalog of the server,
 * which follows `ECCLIUM_TOOLSETS`; with the configuration of the runner
 * the catalog of the runner, which ignores that variable, as the runner
 * does.
 *
 * Why not the catalog of the server for both: a command with the
 * configuration of the runner should depend on no variable the runner
 * container contract does not set, and with the toolset `docs` or `api`
 * the catalog of the server would read the docs index, which no command
 * about a run needs. Taking back, approving and adopting a write call no
 * tool of the catalog; the catalog only backs the audit sink and keeps the
 * pipeline as the runner builds it.
 *
 * @packageDocumentation
 */
import type { EccliumConfig, ToolCatalog } from '@ecclium/mcp-churchtools-core';

import { createRunnerCatalog } from '../runner/start.js';
import { createStdioCatalog } from '../stdio/catalog.js';

/**
 * Builds the catalog of a command for the operator: the catalog of the
 * runner for a configuration of the kind `runner`, otherwise the catalog
 * of the server over stdio.
 *
 * @param config - The checked configuration of the command.
 * @returns The frozen catalog.
 * @throws {DocsIndexError} Over stdio, when `docs` or `api` is on and the
 *   docs index is missing or breaks a rule, as at the start of the server.
 * @throws {RegistryRefusal} When the registry refuses the plugin of the
 *   core or one of its tools.
 * @example
 * ```ts
 * const catalog = commandCatalogOf(config);
 * ```
 */
export function commandCatalogOf(config: EccliumConfig): ToolCatalog {
  return config.transport === 'runner'
    ? createRunnerCatalog(config)
    : createStdioCatalog(config);
}
