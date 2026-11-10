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
  RightRef,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { ChurchToolsClient } from '../churchtools/index.js';
import type { Policy } from '../policy/schema.js';
import type { ToolCatalog } from '../registry/index.js';
import {
  editCategoriesOf,
  type RunAccountNeeds,
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
 * What the rights of the account of a run are judged against: the rights
 * every tool of the routines of the account requires, and the categories
 * the entries with its alias write to.
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
  const rights: RightRef[] = [];
  for (const name of tools) {
    const entry = catalog.get(name);
    if (entry === undefined) return undefined;
    rights.push(...entry.meta.requiredRights);
  }
  const alias = policy.unattended.find(
    (entry) => entry.routine === routine,
  )?.credential;
  const entries =
    alias === undefined
      ? []
      : policy.unattended.filter((entry) => entry.credential === alias);
  return Object.freeze({
    rights: Object.freeze(rights),
    editCategories: editCategoriesOf(entries),
  });
}
