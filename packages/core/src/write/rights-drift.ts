/**
 * Rights an account of a run should not have (ADR 0032): which of its
 * granted rights no tool of its routines needs, and whether an exception
 * of the policy lets its runs write all the same.
 *
 * Where it stands in the way of a write: when the write guard plans the
 * write of a run, right after it read the rights of the account as advice.
 * An account with more rights than its routines need sends the write to
 * the queue of approvals instead of writing, not the run to its end: a
 * right that came with an update of ChurchTools, or was given by mistake,
 * should neither stop every report on a Sunday morning nor pass unseen.
 * The exception `acceptRightsDrift` of the entries of the routine lets the
 * write go on for at most 30 days, and every such write carries a note in
 * the audit.
 *
 * Too wide is every granted right, `true` or a list that is not empty,
 * whose module and name no tool of the routines of this account names in
 * its required rights, and for the right to edit categories of the wiki
 * every category outside the targets of the entries of the account, `true`
 * for all of them included. The scope of a right to read is not compared,
 * because routines choose their sources by names and parameters, not by
 * IDs in the policy. The function is pure and names rights only by module
 * and name, never by a value.
 *
 * @packageDocumentation
 */
import type {
  GrantedRights,
  IsoDate,
  RightRef,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { UnattendedEntry } from '../policy/schema.js';

/** The right whose list of categories is compared with the policy. */
export const wikiEditRight: RightRef = Object.freeze({
  module: 'churchwiki',
  right: 'edit category',
});

/** What the rights of an account are judged against. */
export interface RunAccountNeeds {
  /** The rights the tools of the routines of the account require. */
  readonly rights: readonly RightRef[];
  /** The categories of the wiki the entries of the account write to. */
  readonly editCategories: ReadonlySet<number>;
}

/**
 * The categories of the wiki the entries of an account of the policy
 * write to: the category of a target of a category or of a page.
 *
 * @param entries - The entries of the unattended part with the alias of
 *   the account.
 * @returns The IDs of the categories.
 * @example
 * ```ts
 * editCategoriesOf(policy.unattended.filter((entry) => entry.credential === 'berichte'));
 * ```
 */
export function editCategoriesOf(
  entries: readonly UnattendedEntry[],
): ReadonlySet<number> {
  const categories = new Set<number>();
  for (const { target } of entries) {
    if (target.kind === 'wiki_category') categories.add(target.id);
    if (target.kind === 'wiki_page') categories.add(target.categoryId);
  }
  return categories;
}

/**
 * The granted rights of an account that its routines do not need.
 *
 * @param granted - The rights the account has, as the client read them.
 * @param needs - The rights of the tools and the categories of the
 *   entries of the account.
 * @returns Module and name of each right that is too wide, in the order of
 *   the answer, frozen; empty when none is.
 * @example
 * ```ts
 * rightsBeyond({ churchwiki: { view: true, 'edit category': [12, 13] } },
 *   { rights: [{ module: 'churchwiki', right: 'view' }, wikiEditRight], editCategories: new Set([12]) });
 * // [{ module: 'churchwiki', right: 'edit category' }]
 * ```
 */
export function rightsBeyond(
  granted: GrantedRights,
  needs: RunAccountNeeds,
): readonly RightRef[] {
  const needed = new Set(
    needs.rights.map(({ module, right }) => `${module}\u0000${right}`),
  );
  const beyond: RightRef[] = [];
  for (const [module, rights] of Object.entries(granted)) {
    for (const [right, value] of Object.entries(rights)) {
      // Only `true` and a list with entries grant anything (F5).
      const set = value === true || (Array.isArray(value) && value.length > 0);
      if (!set) continue;
      const ref = Object.freeze({ module, right });
      if (!needed.has(`${module}\u0000${right}`)) {
        beyond.push(ref);
        continue;
      }
      // Editing a category outside the targets of the account, or every
      // category at once, is more than its entries need.
      if (
        module === wikiEditRight.module &&
        right === wikiEditRight.right &&
        (value === true ||
          (value as readonly unknown[]).some(
            (id) => typeof id !== 'number' || !needs.editCategories.has(id),
          ))
      ) {
        beyond.push(ref);
      }
    }
  }
  return Object.freeze(beyond);
}

/**
 * Whether the exception of the entries of a routine for rights its
 * account should not have holds on a UTC day: from its first to its last
 * day, both included.
 *
 * @param entries - The entries of the routine in the unattended part,
 *   which the check of the policy holds to one exception.
 * @param day - The UTC day of the write, or undefined without a clock.
 * @returns Whether the runs of the routine may write that day despite
 *   rights that are too wide.
 * @example
 * ```ts
 * rightsDriftAccepted(entries, '2026-11-10');
 * ```
 */
export function rightsDriftAccepted(
  entries: readonly UnattendedEntry[],
  day: IsoDate | undefined,
): boolean {
  const exception = entries[0]?.acceptRightsDrift;
  if (exception === undefined || day === undefined) return false;
  // Days of the form YYYY-MM-DD compare as text in the order of time.
  return exception.from <= day && day <= exception.until;
}
