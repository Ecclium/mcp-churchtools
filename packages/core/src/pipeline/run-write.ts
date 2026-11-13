/**
 * What the pipeline does in addition for a write of a run of a routine
 * (ADR 0032, ADR 0033): it finds the page the section goes to and the
 * rights the account of the run may have.
 *
 * Where it stands in a run: after the engine rendered the section and
 * before the write tool plans. The engine names the target as the entry
 * of the policy has it, a page by its GUID or a page by its title in a
 * category, and the core reads it itself through its client: a title read
 * through a read tool would come masked and in the envelope of foreign
 * data, so it could not be compared. A page that is missing, or that two
 * pages of the category share by title, ends the write; a run never
 * creates a page.
 *
 * The rights an account of a run may have are those the tools of the
 * routines with this account require, and the categories of the entries
 * of the policy with its alias (`write/rights-drift.ts`).
 *
 * @packageDocumentation
 */
import type {
  GrantedRights,
  IsoDate,
  RightRef,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsClient } from '../churchtools/index.js';
import type { Policy } from '../policy/schema.js';
import type { ToolCatalog } from '../registry/index.js';
import {
  editCategoriesOf,
  rightsBeyond,
  rightsDriftAccepted,
  type RunAccountNeeds,
  wikiEditRight,
} from '../write/rights-drift.js';

/** The most pages of the list of a category a run reads to find its page. */
export const maxRunPageListPages = 40;

/** The page of a write of a run, as the engine names it. */
export type RunPageRef =
  | { readonly categoryId: number; readonly guid: string }
  | { readonly categoryId: number; readonly title: string };

/** The page found, or why there is none. */
export type RunPageFound =
  | {
      readonly ok: true;
      readonly categoryId: number;
      readonly guid: string;
      readonly version: number;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'ambiguous' };

const missing = Object.freeze({ ok: false, reason: 'missing' } as const);
const ambiguous = Object.freeze({ ok: false, reason: 'ambiguous' } as const);

/**
 * Finds the page a run writes its section to, with its version now.
 *
 * @param client - The client of the pipeline.
 * @param ctx - The context of the write of the run.
 * @param page - The page by GUID, or by its title in a category, which
 *   counts in the normal form NFC and exactly.
 * @returns The page with category, GUID and version, or why there is
 *   none.
 * @throws {EccliumError} Every error of a read, such as `network`.
 * @example
 * ```ts
 * const found = await resolveRunPage(client, ctx, { categoryId: 12, title: 'Dienstplan' });
 * ```
 */
export async function resolveRunPage(
  client: Pick<ChurchToolsClient, 'wikiPage' | 'wikiPages'>,
  ctx: TenantContext,
  page: RunPageRef,
): Promise<RunPageFound> {
  const { categoryId } = page;
  if ('guid' in page) {
    try {
      const read = await client.wikiPage(ctx, categoryId, page.guid);
      return Object.freeze({
        ok: true,
        categoryId,
        guid: page.guid.toLowerCase(),
        version: read.version,
      });
    } catch (error) {
      if (isNotFound(error)) return missing;
      throw error;
    }
  }
  const title = page.title.normalize('NFC');
  const found: { readonly guid: string; readonly version: number }[] = [];
  for (let at = 1; at <= maxRunPageListPages; at += 1) {
    const list = await client.wikiPages(ctx, categoryId, at);
    for (const entry of list.pages) {
      if (entry.title.normalize('NFC') === title) {
        found.push({ guid: entry.guid.toLowerCase(), version: entry.version });
      }
    }
    if (!list.more) break;
    // A category longer than this is not searched further: its page could
    // be among the rest, so nothing is written rather than a wrong page.
    if (at === maxRunPageListPages) return missing;
  }
  const [only] = found;
  if (only === undefined) return missing;
  if (found.length > 1) return ambiguous;
  return Object.freeze({ ok: true, categoryId, ...only });
}

// A not_found of the client, read without running code of the value.
const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  Object.getOwnPropertyDescriptor(error, 'code')?.value === 'not_found';

/**
 * What the rights of an account of the runner are judged against: the
 * rights every tool of the routines of the account requires, and the
 * categories the entries with its alias write to.
 *
 * @param catalog - The catalog of tools.
 * @param policy - The checked policy.
 * @param credential - The alias of the account, or undefined for a
 *   routine without an entry, whose account writes to no category.
 * @param tools - The names of the tools of the routines of the account,
 *   their read tools and the write tool of their output.
 * @returns The needs, or undefined when a tool is not in the catalog.
 * @example
 * ```ts
 * accountNeedsOf(catalog, policy, 'berichte', ['ct_events_list', 'ct_wiki_page_append_section']);
 * ```
 */
export function accountNeedsOf(
  catalog: Pick<ToolCatalog, 'get'>,
  policy: Policy,
  credential: string | undefined,
  tools: readonly string[],
): RunAccountNeeds | undefined {
  const rights: RightRef[] = [];
  for (const name of tools) {
    const entry = catalog.get(name);
    if (entry === undefined) return undefined;
    rights.push(...entry.meta.requiredRights);
  }
  const entries =
    credential === undefined
      ? []
      : policy.unattended.filter((entry) => entry.credential === credential);
  return Object.freeze({
    rights: Object.freeze(rights),
    editCategories: editCategoriesOf(entries),
  });
}

/**
 * What the rights of the account of a run are judged against: the needs
 * of the account the entries of its routine name.
 *
 * @param catalog - The catalog of tools.
 * @param policy - The checked policy.
 * @param routine - The ID of the routine of the run.
 * @param tools - The names of the tools of the routines of the account,
 *   their read tools and the write tool of their output.
 * @returns The needs, or undefined when a tool is not in the catalog.
 * @example
 * ```ts
 * runNeedsOf(catalog, policy, 'dienstplan-report', ['ct_events_list', 'ct_wiki_page_append_section']);
 * ```
 */
export function runNeedsOf(
  catalog: Pick<ToolCatalog, 'get'>,
  policy: Policy,
  routine: string,
  tools: readonly string[],
): RunAccountNeeds | undefined {
  return accountNeedsOf(
    catalog,
    policy,
    policy.unattended.find((entry) => entry.routine === routine)?.credential,
    tools,
  );
}

/** The exception of a routine for rights its account should not have. */
export interface RightsException {
  /** The ID of the routine whose entries carry the exception. */
  readonly routine: string;
  /** The last UTC day of the exception. */
  readonly until: IsoDate;
  /** Whether it holds on the day of the check. */
  readonly holds: boolean;
}

/** What the write guard would find for the rights of an account. */
export interface AccountRights {
  /**
   * Module and name of each granted right the routines of the account do
   * not need, in the order of the answer of ChurchTools.
   */
  readonly beyond: readonly RightRef[];
  /**
   * Module and name of each right the tools of the routines of the account
   * require and the account lacks, in the order of the tools, each once;
   * for the right to edit categories also when a category of the entries
   * of the account is missing from its list. A run of such a routine fails
   * on the read or the write that needs it.
   */
  readonly missing: readonly RightRef[];
  /**
   * The exceptions `acceptRightsDrift` of the routines whose entries name
   * the account, in the order of the policy.
   */
  readonly exceptions: readonly RightsException[];
}

// The rights the needs of an account require and the granted rights lack:
// a right that is not set, and the right to edit categories without a
// category of the entries of the account. Read only from own properties.
const rightsMissing = (
  granted: GrantedRights,
  needs: RunAccountNeeds,
): readonly RightRef[] => {
  const missing: RightRef[] = [];
  const seen = new Set<string>();
  for (const { module, right } of needs.rights) {
    const key = `${module}\u0000${right}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rights = Object.hasOwn(granted, module) ? granted[module] : undefined;
    const value =
      rights !== undefined && Object.hasOwn(rights, right)
        ? rights[right]
        : undefined;
    const set = value === true || (Array.isArray(value) && value.length > 0);
    const lacksCategory =
      module === wikiEditRight.module &&
      right === wikiEditRight.right &&
      Array.isArray(value) &&
      [...needs.editCategories].some((id) => !value.includes(id));
    if (!set || lacksCategory) missing.push(Object.freeze({ module, right }));
  }
  return Object.freeze(missing);
};

/**
 * Judges the rights of an account of the runner as the write guard judges
 * them before a write of a run (ADR 0032), for `ecclium doctor`: the same
 * needs, the same comparison and the same days of an exception, so that
 * the check never passes an account whose writes the guard would queue.
 * It names the rights the account lacks as well, on which a read or a
 * write of a run would fail.
 *
 * @param catalog - The catalog of tools.
 * @param policy - The checked policy.
 * @param credential - The alias of the account.
 * @param tools - The tools of the routines of the account that pass their
 *   preparation, as `accountToolsOf` of the workflows gives them.
 * @param granted - The rights of the account, as ChurchTools grants them.
 * @param day - The UTC day of the check.
 * @returns The rights that are too wide, those that are missing and the
 *   exceptions, frozen, or undefined when a tool is not in the catalog.
 * @example
 * ```ts
 * accountRightsOf(catalog, policy, 'berichte', tools, granted, '2026-11-13');
 * ```
 */
export function accountRightsOf(
  catalog: Pick<ToolCatalog, 'get'>,
  policy: Policy,
  credential: string,
  tools: readonly string[],
  granted: GrantedRights,
  day: IsoDate,
): AccountRights | undefined {
  const needs = accountNeedsOf(catalog, policy, credential, tools);
  if (needs === undefined) return undefined;
  const exceptions: RightsException[] = [];
  const seen = new Set<string>();
  for (const { routine, credential: alias } of policy.unattended) {
    if (alias !== credential || seen.has(routine)) continue;
    seen.add(routine);
    // As the write guard reads them: the entries of the routine, whose
    // check holds them to one exception.
    const entries = policy.unattended.filter(
      (entry) => entry.routine === routine,
    );
    const exception = entries[0]?.acceptRightsDrift;
    if (exception === undefined) continue;
    exceptions.push(
      Object.freeze({
        routine,
        until: exception.until,
        holds: rightsDriftAccepted(entries, day),
      }),
    );
  }
  return Object.freeze({
    beyond: rightsBeyond(granted, needs),
    missing: rightsMissing(granted, needs),
    exceptions: Object.freeze(exceptions),
  });
}
