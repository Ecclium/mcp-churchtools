/**
 * Reads the help pages of the Academy for `pnpm docs:refresh` and turns
 * them into the facts of `academy.json` (ADR 0027, ADR 0066): the German
 * help pages of the sections for which Ecclium has tools, of the rights
 * and of the API, each with its path, title, section, knowledge base, the
 * day of its last change and its text as simple Markdown.
 *
 * It reads as the probe of the sources does: `robots.txt` first, then
 * the two taxonomies and the help pages through the REST interface of
 * WordPress, page by page with a pause, never a field about the authors.
 * Nothing it reads is kept apart from the facts.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import {
  academyOrigin,
  maxAcademyPauseMs,
  parseRobots,
  robotsAllow,
  type AcademyClient,
} from '../../spike/lib/academy.mts';
import { SpikeError } from '../../spike/lib/errors.mts';
import { isObject, type JsonObject } from '../../spike/lib/spec.mts';
import { academyPathOf, htmlToLine, htmlToMarkdown } from './html.mts';

/** The User-Agent of the refresh, also its token in `robots.txt`. */
export const refreshAgent = 'ecclium-docs-refresh';

/**
 * The sections of the help pages the index takes, by the slug of their
 * topmost category (ADR 0027, D11): persons, groups, events with the
 * services, calendars, resources, the wiki and the three sections on
 * rights.
 */
export const academySections: readonly string[] = Object.freeze([
  'events',
  'gruppen',
  'kalender',
  'personen',
  'rechteverwaltung-anpassen',
  'rechteverwaltung-nach-modulen',
  'rechteverwaltung-verstehen',
  'ressourcen',
  'wiki',
]);

/**
 * Categories below other sections that the index takes as well, for the
 * areas without a section of their own (D11). The listing of 29.10.2026
 * showed the songs as the category `songs` below `events`, which the
 * index takes anyway, and the API as the category `api` below
 * `integrationen`.
 */
export const academyExtraCategories: readonly string[] = Object.freeze(['api']);

// The lists the refresh reads, with the fields it asks for.
const lists = {
  categories: {
    path: '/de/wp-json/wp/v2/doc_category',
    fields: 'id,slug,parent',
    perPage: 100,
  },
  bases: {
    path: '/de/wp-json/wp/v2/knowledge_base',
    fields: 'id,slug,parent',
    perPage: 100,
  },
  docs: {
    path: '/de/wp-json/wp/v2/docs',
    fields:
      'id,slug,link,status,modified_gmt,title,content,doc_category,knowledge_base',
    perPage: 50,
  },
} as const;

// More pages than this of one list end the reading: 524 help pages are
// 11 pages of 50.
const maxListPages = 40;

/** A term of a taxonomy: its slug and the ID of its parent, 0 at the top. */
export interface Term {
  readonly slug: string;
  readonly parent: number;
}

/** What the refresh read from the Academy. */
export interface AcademyRead {
  /** When the reading started, in UTC, `JJJJ-MM-TTThh:mm:ssZ`. */
  readonly retrievedAt: string;
  readonly categories: ReadonlyMap<number, Term>;
  readonly bases: ReadonlyMap<number, Term>;
  /** The help pages as the interface gave them. */
  readonly docs: readonly JsonObject[];
}

function fail(where: string): never {
  throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', where);
}

function withQuery(
  path: string,
  query: readonly (readonly [string, string])[],
): string {
  const search = new URLSearchParams();
  for (const [name, value] of query) {
    search.append(name, value);
  }
  return `${path}?${search.toString()}`;
}

/**
 * The time as `retrievedAt` takes it: UTC to the second.
 *
 * @param time - A point in time.
 * @returns The time in the form `JJJJ-MM-TTThh:mm:ssZ`.
 */
export function utcSeconds(time: Date): string {
  return `${time.toISOString().slice(0, 19)}Z`;
}

/**
 * Reads `robots.txt`, the categories, the knowledge bases and every help
 * page in German. Before each request it asks `robots.txt` about the
 * path with its query, and it follows a `Crawl-delay` up to the longest
 * pause the client allows.
 *
 * @param academy - The client for the Academy, without a token.
 * @param now - The clock.
 * @param pagesOnly - If false, it reads only the taxonomies, for a listing.
 * @returns What it read.
 * @throws {SpikeError} If `robots.txt` cannot be read or forbids a path,
 *   or if a list has another form.
 */
export async function readAcademy(
  academy: AcademyClient,
  now: () => Date,
  pagesOnly = true,
): Promise<AcademyRead> {
  const retrievedAt = utcSeconds(now());
  const robots = await academy.get({ path: '/robots.txt' });
  // A page in place of the file, such as a challenge in HTML, would read
  // as a file without rules. Only plain text counts as robots.txt.
  const plainText = (robots.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('text/plain');
  if (
    (robots.status !== 200 && robots.status !== 404) ||
    (robots.status === 200 && !plainText)
  ) {
    throw new SpikeError('ANTWORT_UNGUELTIG', 'academyNichtLesbar');
  }
  const rules = parseRobots(
    robots.status === 200 ? robots.text : '',
    refreshAgent,
  );
  if (rules.crawlDelay !== undefined) {
    if (rules.crawlDelay * 1000 > maxAcademyPauseMs) {
      throw new SpikeError('ANTWORT_UNGUELTIG', 'academyNichtLesbar');
    }
    academy.slowDown(rules.crawlDelay * 1000);
  }
  const readList = async (
    list: (typeof lists)[keyof typeof lists],
    name: string,
  ): Promise<JsonObject[]> => {
    const entries: JsonObject[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page += 1) {
      const query = [
        ['per_page', String(list.perPage)],
        ['page', String(page)],
        ['_fields', list.fields],
      ] as const;
      if (!robotsAllow(rules, withQuery(list.path, query))) {
        throw new SpikeError('ANTWORT_UNGUELTIG', 'academyNichtLesbar');
      }
      const answer = await academy.get({ path: list.path, query });
      if (answer.status !== 200 || !Array.isArray(answer.body)) {
        return fail(`academy.${name}[${String(page)}]`);
      }
      if (page === 1) {
        const total = Number(answer.headers.get('x-wp-totalpages') ?? '1');
        // WordPress sends 0 for a list without entries, whose first page
        // was then the only one to read.
        if (!Number.isSafeInteger(total) || total < 0 || total > maxListPages) {
          return fail(`academy.${name}`);
        }
        pages = Math.max(1, total);
      }
      for (const entry of answer.body as unknown[]) {
        if (!isObject(entry)) {
          return fail(`academy.${name}[${String(page)}]`);
        }
        entries.push(entry);
      }
    }
    return entries;
  };
  const categories = termsOf(
    await readList(lists.categories, 'categories'),
    'categories',
  );
  const bases = termsOf(await readList(lists.bases, 'bases'), 'bases');
  const docs = pagesOnly ? await readList(lists.docs, 'docs') : [];
  return { retrievedAt, categories, bases, docs };
}

const slugForm = /^[a-z0-9%][a-z0-9%_-]{0,199}$/;

function termsOf(
  entries: readonly JsonObject[],
  name: string,
): Map<number, Term> {
  const terms = new Map<number, Term>();
  entries.forEach((entry, index) => {
    const id = entry['id'];
    const slug = entry['slug'];
    const parent = entry['parent'];
    if (
      typeof id !== 'number' ||
      typeof slug !== 'string' ||
      !slugForm.test(slug) ||
      (parent !== undefined && typeof parent !== 'number')
    ) {
      fail(`academy.${name}[${String(index)}]`);
    }
    terms.set(id, { slug, parent: typeof parent === 'number' ? parent : 0 });
  });
  return terms;
}

// The chain from a term up to its topmost ancestor, which names the
// section. A loop in the parents ends the chain.
function chainOf(terms: ReadonlyMap<number, Term>, id: number): Term[] {
  const chain: Term[] = [];
  const seen = new Set<number>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const term = terms.get(current);
    if (term === undefined) {
      break;
    }
    chain.push(term);
    if (term.parent === 0) {
      break;
    }
    current = term.parent;
  }
  return chain;
}

function idsOf(value: unknown): number[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((id): id is number => typeof id === 'number')
    : [];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A help page of the format, with its fields in their order. */
export interface AcademyPageEntry {
  readonly path: string;
  readonly title: string;
  readonly section: string;
  readonly knowledgeBase: string;
  readonly modified: string;
  readonly text: string;
}

/** The help pages the index takes and why the others stayed out. */
export interface AcademyPages {
  /** The entries of `academy.json`, sorted by path. */
  readonly entries: readonly AcademyPageEntry[];
  /** Each page with the SHA-256 of its HTML, for `SOURCES.json`. */
  readonly fetched: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  /** Pages of other sections, as the selection wants. */
  readonly otherSections: number;
  /** Pages that are not published or protected by a password. */
  readonly notPublic: number;
  /** Pages of a section without a knowledge base. */
  readonly withoutBase: number;
  /** Pages whose text is empty once prepared, such as one only of images. */
  readonly withoutText: number;
}

/**
 * Selects the help pages of the sections and turns each into a fact.
 *
 * @param read - What {@link readAcademy} read.
 * @param sections - The slugs of the sections to take.
 * @param extra - Slugs of further categories to take, below any section.
 * @returns The facts and the counts of the pages left out.
 * @throws {SpikeError} With the place, if a page of the selection has a
 *   form the format cannot hold, such as a link outside `/de/`, or if two
 *   pages share a path.
 */
export function academyPages(
  read: AcademyRead,
  sections: readonly string[] = academySections,
  extra: readonly string[] = academyExtraCategories,
): AcademyPages {
  const entries: (AcademyPageEntry & { sha256: string })[] = [];
  let otherSections = 0;
  let notPublic = 0;
  let withoutBase = 0;
  let withoutText = 0;
  read.docs.forEach((doc, index) => {
    const where = `academy.docs[${String(index)}]`;
    const chosen = idsOf(doc['doc_category'])
      .map((id) => chainOf(read.categories, id))
      .filter(
        (chain) =>
          sections.includes(chain[chain.length - 1]?.slug ?? '') ||
          chain.some((term) => extra.includes(term.slug)),
      )
      .map((chain) => chain[chain.length - 1]?.slug ?? '')
      .sort(compare);
    const section = chosen[0];
    if (section === undefined) {
      otherSections += 1;
      return;
    }
    const content = isObject(doc['content']) ? doc['content'] : {};
    const html = content['rendered'];
    if (
      doc['status'] !== 'publish' ||
      content['protected'] !== false ||
      typeof html !== 'string'
    ) {
      notPublic += 1;
      return;
    }
    const base = idsOf(doc['knowledge_base'])
      .map((id) => chainOf(read.bases, id))
      .map((chain) => chain[chain.length - 1]?.slug)
      .filter((slug): slug is string => slug !== undefined)
      .sort(compare)[0];
    if (base === undefined) {
      withoutBase += 1;
      return;
    }
    const link = doc['link'];
    let url: URL;
    try {
      url = new URL(typeof link === 'string' ? link : '');
    } catch {
      return fail(`${where}.link`);
    }
    const path =
      url.origin === academyOrigin && url.search === '' && url.hash === ''
        ? academyPathOf(url)
        : undefined;
    if (
      path === undefined ||
      !/^\/de\/(?:[a-z0-9%_-]+\/)*[a-z0-9%_-]+\/?$/.test(path) ||
      path.length > 300
    ) {
      return fail(`${where}.link`);
    }
    const title =
      isObject(doc['title']) && typeof doc['title']['rendered'] === 'string'
        ? htmlToLine(doc['title']['rendered'])
        : undefined;
    if (title === undefined || title.length > 300) {
      return fail(`${where}.title`);
    }
    const modified = doc['modified_gmt'];
    if (typeof modified !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(modified)) {
      return fail(`${where}.modified_gmt`);
    }
    const text = htmlToMarkdown(html, url);
    if (text === '') {
      withoutText += 1;
      return;
    }
    if (text.length > 200_000) {
      return fail(`${where}.content`);
    }
    entries.push({
      path,
      title,
      section,
      knowledgeBase: base,
      modified: modified.slice(0, 10),
      text,
      sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
    });
  });
  entries.sort((a, b) => compare(a.path, b.path));
  entries.forEach((entry, index) => {
    if (index > 0 && entries[index - 1]?.path === entry.path) {
      fail(`academy.pages[${String(index)}].path`);
    }
  });
  return {
    entries: entries.map(
      ({ path, title, section, knowledgeBase, modified, text }) => ({
        path,
        title,
        section,
        knowledgeBase,
        modified,
        text,
      }),
    ),
    fetched: entries.map(({ path, sha256 }) => ({ path, sha256 })),
    otherSections,
    notPublic,
    withoutBase,
    withoutText,
  };
}

/**
 * Lists the categories by their section, with the number of help pages
 * in each, to decide which categories outside the sections the index
 * takes (`--kategorien`). Slugs are public words of the Academy.
 *
 * @param read - What {@link readAcademy} read, with the help pages or without.
 * @returns For each section its slug and the slugs of the categories below it.
 */
export function categoryTree(read: AcademyRead): Record<string, string[]> {
  const tree = new Map<string, Set<string>>();
  for (const id of read.categories.keys()) {
    const chain = chainOf(read.categories, id);
    const root = chain[chain.length - 1]?.slug ?? '';
    const below = tree.get(root) ?? new Set<string>();
    for (const term of chain.slice(0, -1)) {
      below.add(term.slug);
    }
    tree.set(root, below);
  }
  return Object.fromEntries(
    [...tree.keys()]
      .sort(compare)
      .map((root) => [root, [...(tree.get(root) ?? [])].sort(compare)]),
  );
}
