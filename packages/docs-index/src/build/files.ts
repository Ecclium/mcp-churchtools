/**
 * The files the build of the docs index reads and writes (ADR 0066). One
 * of the two places of the package that load `node:fs`, next to
 * `load.ts`. Only `pnpm build` and the tests call it; the server never
 * writes here.
 *
 * Both default paths hold from `src/build/` as from `dist/build/`, two
 * levels under the package.
 *
 * @packageDocumentation
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { buildDocsIndex, docsIndexFileName } from '../artifact.js';
import { factFiles, type FactFileTexts } from '../facts.js';

/** Where the build reads the facts and writes the built file. */
export interface BuildLocations {
  /** The folder with the files of facts, ending in `/`. */
  readonly dataDir: URL;
  /** The built file. */
  readonly outFile: URL;
}

/**
 * The folder `data/` and the file `dist/docs-index.json` of this package.
 *
 * @returns The locations.
 * @example
 * ```ts
 * writeDocsIndex(defaultBuildLocations());
 * ```
 */
export function defaultBuildLocations(): BuildLocations {
  return {
    dataDir: new URL('../../data/', import.meta.url),
    outFile: new URL(`../../dist/${docsIndexFileName}`, import.meta.url),
  };
}

/**
 * Reads the five files of facts from a folder.
 *
 * @param dataDir - The folder, ending in `/`.
 * @returns The text of each file.
 * @throws {Error} If a file cannot be read.
 * @example
 * ```ts
 * const texts = readFactFiles(defaultBuildLocations().dataDir);
 * ```
 */
export function readFactFiles(dataDir: URL): FactFileTexts {
  const read = (name: string) => readFileSync(new URL(name, dataDir), 'utf8');
  return {
    'SOURCES.json': read(factFiles.sources),
    'operations.json': read(factFiles.operations),
    'rights.json': read(factFiles.rights),
    'academy.json': read(factFiles.academy),
    'operation-rights.json': read(factFiles.operationRights),
  };
}

/**
 * Builds the docs index from the facts and writes the built file. Nothing
 * is written if a check fails.
 *
 * @param locations - Where to read and write, by default this package.
 * @returns The number of bytes written.
 * @throws {DocsFactsError} If the facts break a rule.
 * @throws {DocsIndexError} If the built file breaks one.
 * @throws {Error} If a file cannot be read or written.
 * @example
 * ```ts
 * writeDocsIndex();
 * ```
 */
export function writeDocsIndex(
  locations: BuildLocations = defaultBuildLocations(),
): number {
  const text = buildDocsIndex(readFactFiles(locations.dataDir));
  mkdirSync(new URL('.', locations.outFile), { recursive: true });
  writeFileSync(locations.outFile, text);
  return Buffer.byteLength(text, 'utf8');
}
