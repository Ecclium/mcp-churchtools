/**
 * The checks of the core for a routine without a model (ADR 0033).
 *
 * Where they stand in a run: in place of the inputs and the model. A
 * routine with `checks` chooses fixed checks the core brings and only sets
 * their limits. They read the wiki through the same port as the inputs of
 * a routine with a model, so every read goes through the pipeline, with
 * its audit line, the rights of the account and the mode `unattended`, and
 * they fill one block per check, named like the check, which the template
 * renders as it would the answer of a model.
 *
 * What they read: the categories the account of the routine sees, the
 * list of the pages of each and, for `brokenLinks`, the text of every page
 * in all its parts. Of a page in the list they take the GUID, the title
 * and the date of its last change; the client reads no person of the list
 * at all. They read in the level `standard`: no model sees the data, the
 * tools of the wiki give no person in a field of its own, and the level
 * `strict` would mask a part of a GUID in a link as a phone number
 * (decided on 12.11.2026).
 *
 * What they report: titles and names of categories as plain text, each
 * through the content policy of a text of a run on its own. A value it
 * refuses gives way to a fixed text, so that one title cannot fail every
 * run. A link appears as «Kategorie › Seite», never as an address, and a
 * link to a page the account may not see looks like one to a page that is
 * missing.
 *
 * Limits: at most {@link runReadLimits}.callsPerRun reads. A run that needs
 * more ends with `run_calls_exhausted`, never with a report that leaves
 * pages out. A block holds at most the `maxItems` of its check, in a fixed
 * order, and the template says so.
 *
 * @packageDocumentation
 */
import {
  checkRunText,
  escapeRunText,
  runDataText,
} from '@ecclium/mcp-churchtools-core';
import {
  type ErrorCode,
  type Logger,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';

import { routineLimits, type RoutineCheck } from '../routine/schema.js';
import type { FilledBlocks } from './answer.js';
import { runReadLimits, type RunRead } from './inputs.js';

/** What the checks need besides the reads. */
export interface CheckContext {
  /**
   * The origin of the instance, such as `https://example.church.tools`,
   * so that only links to the own instance count.
   */
  readonly origin: string;
  /** The zone of the runner, for the day of a change. */
  readonly timeZone: string;
}

/** The text in place of a title or name the content policy refuses. */
export const hiddenTitle = '(Titel nicht darstellbar)';

/** The name of the main page of a category in a report. */
export const mainPageName = 'Hauptseite';

/**
 * The text in place of the GUID of a link the content policy refuses,
 * since parts of a GUID can look like a phone number.
 */
export const hiddenGuid = '(Seite über ihre GUID verlinkt)';

/**
 * The most bytes the values of one block take, escaped as the template
 * sets them, so that two blocks and the template stay well within the
 * longest text of a page the content policy takes.
 */
export const maxBlockBytes = 24_000;

/** What the checks filled, or why the run ends. */
export type ChecksResult =
  | {
      readonly ok: true;
      readonly blocks: FilledBlocks;
      /** How many entries the blocks hold together. */
      readonly entries: number;
      /** How many reads the checks made. */
      readonly calls: number;
    }
  | {
      readonly ok: false;
      /**
       * The code of a read, `run_calls_exhausted` beyond the limit of
       * reads, or `run_page_date_missing` for a page in the list without
       * the date of its last change while `stalePages` runs.
       */
      readonly code:
        ErrorCode | 'run_calls_exhausted' | 'run_page_date_missing';
      /** Whether a later try may pass (ADR 0034). */
      readonly transient: boolean;
    };

// The most entries one read passes on: more than any tool of the wiki
// gives in one call, so that the pipeline cuts none.
const entriesPerCall = 100;

const dayMs = 86_400_000;

// A run that ends: the code and whether a later try may pass. It never
// leaves runChecks, which turns it into a result.
class Stop extends Error {
  readonly code: ErrorCode | 'run_calls_exhausted' | 'run_page_date_missing';
  readonly transient: boolean;
  constructor(code: Stop['code'], transient: boolean) {
    super(code);
    this.code = code;
    this.transient = transient;
  }
}

// An own data property of a plain object, never through a getter.
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

const listOf = (value: unknown, key: string): readonly unknown[] => {
  const items = ownData(value, key);
  return Array.isArray(items) ? (items as readonly unknown[]) : [];
};

const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** A category the account sees. */
interface Category {
  readonly id: number;
  readonly name: string;
}

/** A page of the list of a category. */
interface Page {
  readonly category: Category;
  readonly guid: string;
  readonly title: string;
  /** Milliseconds since the epoch, or undefined without a date. */
  readonly changed: number | undefined;
}

/** A link to a page of the wiki of the own instance. */
export interface WikiLink {
  /** The ID of the category the link names. */
  readonly categoryId: number;
  /**
   * The page as the link names it, decoded: `main` for the main page and
   * for a link to the category alone, a GUID or a title.
   */
  readonly page: string;
  /**
   * The page without signs that end a sentence, such as a full stop after
   * an address in running text, when it has such signs at its end.
   */
  readonly trimmed?: string;
}

const escapeForPattern = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

// A text without regard to case: each letter as both of its cases.
const anyCase = (text: string): string =>
  Array.from(text)
    .map((sign) =>
      /^[a-z]$/iu.test(sign)
        ? `[${sign.toLowerCase()}${sign.toUpperCase()}]`
        : escapeForPattern(sign),
    )
    .join('');

// One sign of a segment of an address. The web interface leaves brackets
// and apostrophes in a title as they are, so brackets count when they pair
// up (F55).
const segmentSign = String.raw`[^\s"<>\[\]#?/()]`;
const segment = String.raw`(?:${segmentSign}|\(${segmentSign}*\))+`;

// Signs that end a sentence and may stand after an address in running text.
const sentenceEnd = /[.,;:!]+$/u;

// Segments of the web interface of the wiki that name no page, such as
// the list of all pages of a category.
const interfaceSegments: readonly string[] = Object.freeze(['sitemap']);

/**
 * The links to pages of the wiki of the own instance in a text of a page,
 * in the form the web interface of ChurchTools gives in its address bar:
 * `/wiki/<ID of the category>/<title>`, with the title encoded for an
 * address, `main` for the main page, or the category alone. ChurchTools
 * finds a page also by its GUID there, and both without regard to case
 * (F55). A link counts with the scheme and host of the instance, without
 * regard to their case or without the scheme, or as a path alone, each
 * only where an address starts; a link to another origin, the list of all
 * pages or a file is none. Of a link with an anchor or a query only the
 * page counts. Each link appears once, in the order of the text.
 *
 * @param text - The whole text of a page, Markdown or HTML.
 * @param origin - The origin of the instance.
 * @returns The links, frozen.
 * @example
 * ```ts
 * wikiLinksIn('[A](/wiki/3/main)', 'https://example.church.tools');
 * // [{ categoryId: 3, page: 'main' }]
 * ```
 */
export function wikiLinksIn(text: string, origin: string): readonly WikiLink[] {
  const url = new URL(origin);
  // An address starts at the start of the text, after a space, a bracket
  // or a quote, never inside another address, so that the path of a link
  // to another host never reads as one to the own instance.
  const pattern = new RegExp(
    String.raw`(?<=^|[\s("'<\[])(?:(?:${anyCase(url.protocol)})?//${anyCase(url.host)})?/wiki/(\d{1,15})(?:/(${segment}))?(?![\w%])`,
    'gu',
  );
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const match of text.matchAll(pattern)) {
    const categoryId = Number(match[1]);
    if (!isWhole(categoryId)) continue;
    // HTML writes an ampersand in an address as an entity.
    const raw = (match[2] ?? 'main').replaceAll('&amp;', '&');
    if (interfaceSegments.includes(raw.toLowerCase())) continue;
    let page: string;
    try {
      page = decodeURIComponent(raw);
    } catch {
      // An address with a broken escape names no page anyone could find.
      page = raw;
    }
    page = page.normalize('NFC');
    const key = `${String(categoryId)}/${page.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const trimmed = page.replace(sentenceEnd, '');
    links.push(
      Object.freeze(
        trimmed !== page && trimmed !== ''
          ? { categoryId, page, trimmed }
          : { categoryId, page },
      ),
    );
  }
  return Object.freeze(links);
}

/**
 * Runs the checks of a routine and fills their blocks.
 *
 * @param checks - The checks of the routine.
 * @param read - The port of the composition root.
 * @param context - The origin of the instance and the zone of the runner.
 * @param now - The time of the trigger the run serves, in milliseconds
 *   since the epoch, so that a later try counts the same days.
 * @param log - The logger of the run.
 * @param signal - The signal of the run.
 * @returns The filled blocks, or the first failure. It never throws for a
 *   failed read.
 * @example
 * ```ts
 * const checked = await runChecks(routine.checks, read, context, trigger.at, log, signal);
 * if (!checked.ok) return failed('input', checked.code, !checked.transient);
 * ```
 */
export async function runChecks(
  checks: readonly RoutineCheck[],
  read: RunRead,
  context: CheckContext,
  now: number,
  log: Logger,
  signal: AbortSignal,
): Promise<ChecksResult> {
  let calls = 0;

  const call = async (
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    if (calls >= runReadLimits.callsPerRun) {
      log.warn('run_read_limit', { count: calls });
      throw new Stop('run_calls_exhausted', false);
    }
    calls += 1;
    const outcome = await read(tool, input, entriesPerCall, signal);
    if (!outcome.ok) {
      log.warn('run_read_failed', { code: outcome.code });
      throw new Stop(outcome.code, outcome.transient);
    }
    return outcome.data;
  };

  // A title or a name as plain text, or a fixed text when the content
  // policy refuses it. Only the contact values of the policy would count,
  // and a title is no place for them.
  const plain = (value: string, fallback = hiddenTitle): string => {
    const checked = checkRunText(value, new Set());
    return checked.ok ? checked.text : fallback;
  };

  try {
    const categories: Category[] = [];
    for (let page = 1; ; page += 1) {
      const data = await call('ct_wiki_categories_list', { page });
      for (const item of listOf(data, 'categories')) {
        const id = ownData(item, 'id');
        const name = runDataText(ownData(item, 'name'));
        if (isWhole(id) && name !== undefined) categories.push({ id, name });
      }
      if (ownData(data, 'more') !== true) break;
    }

    const pages: Page[] = [];
    for (const category of categories) {
      for (let page = 1; ; page += 1) {
        const data = await call('ct_wiki_pages_list', {
          categoryId: category.id,
          page,
        });
        for (const item of listOf(data, 'pages')) {
          const guid = ownData(item, 'guid');
          const title = runDataText(ownData(item, 'title'));
          const date = ownData(item, 'modifiedDate');
          const changed = typeof date === 'string' ? Date.parse(date) : NaN;
          if (typeof guid !== 'string' || title === undefined) continue;
          pages.push({
            category,
            guid,
            title,
            changed: Number.isFinite(changed) ? changed : undefined,
          });
        }
        if (ownData(data, 'more') !== true) break;
      }
    }

    const blocks: Record<string, readonly Readonly<Record<string, string>>[]> =
      {};
    for (const check of checks) {
      blocks[check.check] =
        check.check === 'stalePages'
          ? stalePages(check, pages, context, now, plain)
          : await brokenLinks(check, pages, categories, context, call, plain);
    }
    let entries = 0;
    for (const list of Object.values(blocks)) entries += list.length;
    return Object.freeze({
      ok: true,
      blocks: Object.freeze(blocks),
      entries,
      calls,
    });
  } catch (error) {
    if (error instanceof Stop) {
      return Object.freeze({
        ok: false,
        code: error.code,
        transient: error.transient,
      });
    }
    throw error;
  }
}

// The day of a time in the zone of the runner, as the report writes it.
const dayOf = (at: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}`;
};

// A value of a report within the length of its field, the longest name
// of the schema, cut between two code points with three dots, the normal
// form the content policy gives an ellipsis.
const fit = (text: string): string => {
  const points = Array.from(text);
  return points.length <= routineLimits.name
    ? text
    : `${points.slice(0, routineLimits.name - 3).join('')}...`;
};

// A value as the report holds it: each part checked on its own, then
// joined, cut to the length of its field and checked once more, since a
// join or a cut can make a text the content policy refuses, such as a web
// address cut at its dot.
const final = (
  text: string,
  plain: (value: string, fallback?: string) => string,
): string => plain(fit(plain(text)));

const encoder = new TextEncoder();

// The entries of a block in their order while their values, escaped as
// the template sets them, stay within maxBlockBytes; like maxItems, a
// cut in a fixed order.
const withinBytes = (
  entries: readonly Readonly<Record<string, string>>[],
): readonly Readonly<Record<string, string>>[] => {
  const kept: Readonly<Record<string, string>>[] = [];
  let bytes = 0;
  for (const entry of entries) {
    for (const value of Object.values(entry)) {
      bytes += encoder.encode(escapeRunText(value)).length;
    }
    if (bytes > maxBlockBytes) break;
    kept.push(entry);
  }
  return Object.freeze(kept);
};

const byText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// The pages no one changed for the days of the check, the oldest first.
// A page without a date ends the run, so that the report never says no
// page is old because it could not tell.
const stalePages = (
  check: Extract<RoutineCheck, { check: 'stalePages' }>,
  pages: readonly Page[],
  context: CheckContext,
  now: number,
  plain: (value: string, fallback?: string) => string,
): readonly Readonly<Record<string, string>>[] => {
  const before = now - check.olderThanDays * dayMs;
  const stale: (Page & { readonly changed: number })[] = [];
  for (const page of pages) {
    if (page.changed === undefined)
      throw new Stop('run_page_date_missing', false);
    if (page.changed < before) stale.push({ ...page, changed: page.changed });
  }
  stale.sort(
    (left, right) =>
      left.changed - right.changed ||
      byText(left.category.name, right.category.name) ||
      byText(left.title, right.title),
  );
  return withinBytes(
    stale.slice(0, check.maxItems).map((page) =>
      Object.freeze({
        page: final(page.title, plain),
        category: final(page.category.name, plain),
        changed: dayOf(page.changed, context.timeZone),
      }),
    ),
  );
};

// The links to pages of the own wiki whose target the account does not
// find, in the order of category, page and target.
const brokenLinks = async (
  check: Extract<RoutineCheck, { check: 'brokenLinks' }>,
  pages: readonly Page[],
  categories: readonly Category[],
  context: CheckContext,
  call: (
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>,
  plain: (value: string, fallback?: string) => string,
): Promise<readonly Readonly<Record<string, string>>[]> => {
  const byId = new Map(categories.map((category) => [category.id, category]));
  // ChurchTools finds a page by its GUID or its title, both without regard
  // to case; the main page is a page with the title `main`.
  const names = new Map<number, Set<string>>();
  for (const page of pages) {
    const id = page.category.id;
    if (!names.has(id)) names.set(id, new Set());
    names.get(id)?.add(page.guid.toLowerCase());
    names.get(id)?.add(page.title.normalize('NFC').toLowerCase());
  }
  const known = (categoryId: number, page: string | undefined): boolean =>
    page !== undefined &&
    (names.get(categoryId)?.has(page.toLowerCase()) ?? false);
  // A link whose page ends with a sign that ends a sentence finds its
  // target with or without that sign.
  const exists = (link: WikiLink): boolean =>
    byId.has(link.categoryId) &&
    (known(link.categoryId, link.page) || known(link.categoryId, link.trimmed));

  const found: {
    readonly page: string;
    readonly link: string;
  }[] = [];
  for (const page of pages) {
    let text = '';
    try {
      // Every part after the first from the version of the first, so
      // that a change in between neither mixes two texts nor ends the run
      // at a part the shorter text no longer has.
      let version: number | undefined;
      for (let part = 1, parts = 1; part <= parts; part += 1) {
        const data = await call('ct_wiki_page_get', {
          categoryId: page.category.id,
          guid: page.guid,
          part,
          ...(version === undefined ? {} : { version }),
        });
        if (part === 1) {
          const count = ownData(data, 'parts');
          const read = ownData(data, 'version');
          if (isWhole(count)) parts = count;
          if (isWhole(read)) version = read;
        }
        text += runDataText(ownData(data, 'text')) ?? '';
      }
    } catch (error) {
      // A page deleted after the list was read has no links any more.
      if (error instanceof Stop && error.code === 'not_found') continue;
      throw error;
    }
    for (const link of wikiLinksIn(text, context.origin)) {
      if (exists(link)) continue;
      const category = byId.get(link.categoryId);
      const target = link.trimmed ?? link.page;
      const name =
        target.toLowerCase() === 'main'
          ? mainPageName
          : wikiPageGuidPattern.test(target)
            ? plain(target, hiddenGuid)
            : plain(target);
      found.push({
        page: final(
          `${plain(page.category.name)} › ${plain(page.title)}`,
          plain,
        ),
        link: final(
          `${category === undefined ? `Kategorie ${String(link.categoryId)}` : plain(category.name)} › ${name}`,
          plain,
        ),
      });
    }
  }
  found.sort(
    (left, right) =>
      byText(left.page, right.page) || byText(left.link, right.link),
  );
  return withinBytes(
    found
      .slice(0, check.maxItems)
      .map((entry) => Object.freeze({ page: entry.page, link: entry.link })),
  );
};
