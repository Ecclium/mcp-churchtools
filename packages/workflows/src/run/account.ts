/**
 * The tools of an account of the runner (ADR 0032, ADR 0033): every tool
 * that the routines with this alias read or write with. The write guard
 * holds the rights of the account against the rights these tools require,
 * and a right none of them needs sends the write of a run to the queue of
 * approvals.
 *
 * Why every routine of the alias and not only the one that runs: an
 * account serves all of them, so a right one of them needs is no drift
 * for another. Which alias a routine has comes from the policy, here as
 * in the composition root. A routine without an entry reads with the own
 * account of the runner (ADR 0023, ADR 0033), so its tools count for the
 * alias `runner`, which the policy may name as well. The list must be
 * exact both ways. A tool too many would hide a right the account should
 * not have; a tool too few would send every write to the queue for a
 * right another routine needs.
 *
 * @packageDocumentation
 */
import { runnerOwnAlias } from '@ecclium/mcp-churchtools-core';

import { checkTools } from '../routine/check.js';
import type { PreparedRun } from './prepare.js';

/**
 * The tools of the prepared routines whose entries of the policy name an
 * alias, and for the alias `runner` also of those without an entry: the
 * read tools of their inputs and of their checks of the core and the write
 * tool of an output in the wiki,
 * each once, in the order of the names. Only a routine that
 * passed its preparation counts, so that every tool is one the catalog
 * knows and a routine that never runs widens nothing.
 *
 * @param runs - Every routine the runner prepared.
 * @param credential - The alias of the account.
 * @returns The names of the tools, frozen.
 * @example
 * ```ts
 * const accountTools = accountToolsOf(prepared, 'berichte');
 * ```
 */
export function accountToolsOf(
  runs: readonly PreparedRun[],
  credential: string,
): readonly string[] {
  const tools = new Set<string>();
  for (const run of runs) {
    if ((run.credential ?? runnerOwnAlias) !== credential) continue;
    for (const { input } of run.inputs) tools.add(input.tool);
    for (const { check } of run.loaded.routine.checks ?? []) {
      for (const tool of checkTools[check]) tools.add(tool);
    }
    const { output } = run.loaded.routine;
    if (output.target === 'wiki') tools.add(output.tool);
  }
  return Object.freeze([...tools].sort());
}
