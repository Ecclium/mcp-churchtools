/**
 * The built docs index (ADR 0066): one JSON file with the checked facts of
 * every source and a search index for each. `pnpm build` writes it to
 * `dist/docs-index.json`, and it never lies in the repository. Its bytes
 * depend only on the facts: the facts come in canonical form, the search
 * index holds only strings and whole numbers, and nothing reads the clock,
 * the time zone or the language of the machine.
 *
 * Building and loading check the same rules, so a file changed after the
 * build fails to load just as wrong facts fail to build. No error names a
 * value from the file.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

import {
  canonicalJson,
  DocsFactsError,
  type FactFileTexts,
  type Facts,
  parseFactFiles,
} from './facts.js';
import { findHostsIn, walkStrings } from './hosts.js';
import {
  hasHtmlTag,
  looksLikeHtmlPage,
  looksLikeOpenApiDocument,
} from './raw-sources.js';
import {
  buildSearchIndex,
  type SearchField,
  type SerializedSearchIndex,
} from './search/build.js';
import { maxWordLength } from './search/words.js';

/** The format of the built file. */
export const docsIndexFormat = 'ecclium.docs-index.v1';

/** The name of the built file in `dist/`. */
export const docsIndexFileName = 'docs-index.json';

/**
 * The largest built file in bytes, facts and search together, so that the
 * package stays small (ADR 0066).
 */
export const maxDocsIndexBytes = 5_000_000;

/** The fields each source is searched in, with their weights. */
export const searchFields = Object.freeze({
  operations: Object.freeze([
    { name: 'operationId', weight: 4 },
    { name: 'path', weight: 3 },
    { name: 'summary', weight: 3 },
    { name: 'tags', weight: 2 },
    { name: 'parameters', weight: 1 },
    { name: 'description', weight: 1 },
  ]),
  rights: Object.freeze([
    { name: 'name', weight: 4 },
    { name: 'label', weight: 4 },
    { name: 'module', weight: 2 },
  ]),
  academy: Object.freeze([
    { name: 'title', weight: 4 },
    { name: 'section', weight: 2 },
    { name: 'text', weight: 1 },
  ]),
} satisfies Record<string, readonly SearchField[]>);

/** The search index of each source. */
export interface DocsIndexSearch {
  /** Over the operations. */
  readonly operations: SerializedSearchIndex;
  /** Over the rights. */
  readonly rights: SerializedSearchIndex;
  /** Over the help pages. */
  readonly academy: SerializedSearchIndex;
}

/** The content of a built file, checked. */
export interface DocsIndexContent {
  /** The facts of every source. */
  readonly facts: Facts;
  /** The search index of each source. */
  readonly search: DocsIndexSearch;
}

/** Why a built file cannot be made or used. */
export type DocsIndexProblem =
  | 'facts'
  | 'format'
  | 'host'
  | 'html'
  | 'json'
  | 'missing'
  | 'raw-source'
  | 'search'
  | 'size';

/**
 * The built docs index cannot be made or used. The message names the
 * problem and at most a path of a field, never a value.
 *
 * @example
 * ```ts
 * try {
 *   parseDocsIndex(text);
 * } catch (error) {
 *   if (error instanceof DocsIndexError) report(error.problem);
 * }
 * ```
 */
export class DocsIndexError extends Error {
  /** The kind of problem. */
  readonly problem: DocsIndexProblem;
  /** The field it is in, or `` for the whole file. */
  readonly path: string;

  /**
   * Creates the error.
   *
   * @param problem - The kind of problem.
   * @param path - The field it is in.
   * @param options - The cause, if another error led to it.
   */
  constructor(problem: DocsIndexProblem, path = '', options?: ErrorOptions) {
    super(
      `The docs index cannot be used: ${problem}${path === '' ? '' : ` at ${path}`}.`,
      options,
    );
    this.name = 'DocsIndexError';
    this.problem = problem;
    this.path = path;
  }
}

/**
 * The key of a right in its search index: module and name, apart by a
 * character no name contains, so that the keys sort as the facts do.
 *
 * @param module - The module of the right.
 * @param name - The name of the right.
 * @returns The key.
 * @example
 * ```ts
 * rightKey('churchwiki', 'view'); // 'churchwiki\u0000view'
 * ```
 */
export function rightKey(module: string, name: string): string {
  return `${module}\u0000${name}`;
}

/**
 * Builds the docs index from the texts of the files under `data/`: checks
 * them with {@link parseFactFiles}, adds a search index for each source
 * and checks the result again for its size, hosts, markup and the form
 * of a raw source.
 *
 * @param texts - The text of each file under `data/`.
 * @returns The text of the built file, compact JSON.
 * @throws {DocsFactsError} If the facts break a rule.
 * @throws {DocsIndexError} If the built file breaks one.
 * @example
 * ```ts
 * const text = buildDocsIndex(readFactFiles(dataDir));
 * ```
 */
export function buildDocsIndex(texts: FactFileTexts): string {
  const facts = parseFactFiles(texts);
  const artifact = {
    format: docsIndexFormat,
    sources: facts.sources,
    operations: facts.operations,
    rights: facts.rights,
    academy: facts.academy,
    search: {
      operations: buildSearchIndex(
        searchFields.operations,
        facts.operations.entries.map((operation) => ({
          key: operation.operationId,
          texts: [
            operation.operationId,
            operation.path,
            operation.summary ?? '',
            operation.tags.join(' '),
            operation.parameters.map(({ name }) => name).join(' '),
            operation.description ?? '',
          ],
        })),
      ),
      rights: buildSearchIndex(
        searchFields.rights,
        facts.rights.entries.map((right) => ({
          key: rightKey(right.module, right.name),
          texts: [right.name, right.label?.text ?? '', right.module],
        })),
      ),
      academy: buildSearchIndex(
        searchFields.academy,
        facts.academy.entries.map((page) => ({
          key: page.path,
          texts: [page.title, page.section, page.text],
        })),
      ),
    },
  };
  const text = JSON.stringify(artifact);
  checkBuilt(artifact, text);
  return text;
}

/**
 * Reads a built file and checks it as strictly as the build: its size,
 * hosts, markup and the form of a raw source, its format, the facts with
 * {@link parseFactFiles} and the search indexes against the facts.
 *
 * @param text - The text of a built file.
 * @returns The facts and the search indexes.
 * @throws {DocsIndexError} If the file breaks a rule; a broken fact is
 *   the problem `facts`, with the findings in its cause.
 * @example
 * ```ts
 * const { facts } = parseDocsIndex(text);
 * ```
 */
export function parseDocsIndex(text: string): DocsIndexContent {
  if (Buffer.byteLength(text, 'utf8') > maxDocsIndexBytes) {
    throw new DocsIndexError('size');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DocsIndexError('json');
  }
  // The same checks as after the build, before anything else reads the
  // file: a file changed afterwards could hold a host or markup in a part
  // that no check of the facts sees, such as the words of a search.
  checkBuilt(json, text);
  const parsed = artifactSchema.safeParse(json);
  if (!parsed.success) {
    throw new DocsIndexError('format');
  }
  let facts: Facts;
  try {
    facts = parseFactFiles({
      'SOURCES.json': canonicalJson(parsed.data.sources),
      'operations.json': canonicalJson(parsed.data.operations),
      'rights.json': canonicalJson(parsed.data.rights),
      'academy.json': canonicalJson(parsed.data.academy),
    });
  } catch (error) {
    if (error instanceof DocsFactsError) {
      throw new DocsIndexError('facts', '', { cause: error });
    }
    throw error;
  }
  const search: DocsIndexSearch = parsed.data.search;
  const expected = {
    operations: facts.operations.entries.map(({ operationId }) => operationId),
    rights: facts.rights.entries.map(({ module, name }) =>
      rightKey(module, name),
    ),
    academy: facts.academy.entries.map(({ path }) => path),
  };
  for (const source of ['operations', 'rights', 'academy'] as const) {
    const index = search[source];
    const fields = searchFields[source];
    if (
      !sameList(
        index.fields,
        fields.map(({ name }) => name),
      ) ||
      !sameList(
        index.weights,
        fields.map(({ weight }) => weight),
      ) ||
      !sameList(index.keys, expected[source])
    ) {
      throw new DocsIndexError('search', `search.${source}`);
    }
  }
  return { facts, search };
}

function sameList<T>(a: readonly T[], c: readonly T[]): boolean {
  return a.length === c.length && a.every((item, index) => item === c[index]);
}

// The built file is checked again as a whole, although its facts passed:
// the search adds keys and words, and a mistake in the build must not
// carry a host or markup into the package.
function checkBuilt(artifact: unknown, text: string): void {
  if (Buffer.byteLength(text, 'utf8') > maxDocsIndexBytes) {
    throw new DocsIndexError('size');
  }
  const [host] = findHostsIn(artifact);
  if (host !== undefined) {
    throw new DocsIndexError('host', host.path);
  }
  walkStrings(artifact, (path, value) => {
    if (hasHtmlTag(value)) {
      throw new DocsIndexError('html', path);
    }
  });
  if (looksLikeOpenApiDocument(text) || looksLikeHtmlPage(text)) {
    throw new DocsIndexError('raw-source');
  }
}

const count = z.int().nonnegative();

const searchIndexSchema = z.strictObject({
  fields: z.array(z.string().max(64)).min(1).max(20),
  weights: z.array(z.int().min(1).max(10)).min(1).max(20),
  keys: z.array(z.string().max(500)).max(10_000),
  lengths: z.array(z.array(count).max(20)).max(10_000),
  terms: z
    .array(
      z
        .string()
        .min(1)
        .max(maxWordLength * 2),
    )
    .max(1_000_000),
  postings: z.array(z.array(count).min(3)).max(1_000_000),
});

// The facts are checked by parseFactFiles, which knows their formats; here
// only the frame and the search indexes.
const artifactSchema = z.strictObject({
  format: z.literal(docsIndexFormat),
  sources: z.unknown(),
  operations: z.unknown(),
  rights: z.unknown(),
  academy: z.unknown(),
  search: z.strictObject({
    operations: searchIndexSchema,
    rights: searchIndexSchema,
    academy: searchIndexSchema,
  }),
});
