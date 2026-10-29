/**
 * Reads the built docs index from the package (ADR 0066). One of the two
 * places of the package that load `node:fs`, next to the build in
 * `build/files.ts`. The composition root calls {@link readDocsIndex} once
 * per process.
 *
 * The file lies in `dist/` of this package. The path below holds from
 * `src/` as from `dist/`, both one level under the package. A bundle of
 * the product package will have to carry the file along (ADR 0022).
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';

import { docsIndexFileName, DocsIndexError } from './artifact.js';
import { type DocsIndex, openDocsIndex } from './docs-index.js';

/**
 * The built file of this package, `dist/docs-index.json`.
 *
 * @returns Its location.
 * @example
 * ```ts
 * readDocsIndex(defaultDocsIndexFile());
 * ```
 */
export function defaultDocsIndexFile(): URL {
  return new URL(`../dist/${docsIndexFileName}`, import.meta.url);
}

/**
 * Reads, checks and opens a built docs index.
 *
 * @param file - The built file, by default the one of this package.
 * @returns The index, frozen.
 * @throws {DocsIndexError} If the file is missing or breaks a rule, such
 *   as its size. The error never names the path of the file.
 * @example
 * ```ts
 * const index = readDocsIndex();
 * ```
 */
export function readDocsIndex(file: URL = defaultDocsIndexFile()): DocsIndex {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // The error of the file system names the path, which may show the
    // home folder of the operator; only the kind of problem goes on.
    throw new DocsIndexError('missing');
  }
  return openDocsIndex(text);
}
