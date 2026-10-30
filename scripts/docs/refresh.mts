/**
 * `pnpm docs:refresh`: writes the facts of the docs index from their
 * sources into `packages/docs-index/data/` (ADR 0027, ADR 0066).
 *
 * Reads: the OpenAPI document from the state file of 00-inventory,
 * without a request; `GET /api/permissions/global` with the account of
 * the token file; and the German help pages of the Academy through the
 * REST interface of WordPress, with its own User-Agent, after
 * `robots.txt` and with a pause between two requests.
 * Writes: the five files under `packages/docs-index/data/`, only once
 * all of them are made, with the labels of the rights and the pairings of
 * operations and rights from the mapping by hand in `rights-mapping.json`.
 * No raw source is written anywhere.
 * Prints: counts, sizes and fixed words, never a text, a link or a host
 * of a source. The checks of the package then read the files: run
 * `pnpm build` and `pnpm check` afterwards.
 *
 * With `--kategorien` it reads only the categories of the Academy and
 * prints their slugs by section, to decide which categories outside the
 * sections the index takes. It writes nothing then.
 *
 * With `--nur-katalog` it reads no source, only `operations.json`
 * under `data/`, and writes the generated part of the operation catalog
 * of the escape hatch in the core anew (ADR 0067). The full refresh
 * writes it as well, after the facts.
 *
 * With `--nur-zuordnung` it reads no source, only the files under
 * `data/` and the mapping, and writes `rights.json` and
 * `operation-rights.json` anew, so that a change of the mapping needs no
 * run against an instance. With `ECCLIUM_SPIKE_BASE_URL` set, it checks
 * them for the name of that instance as the full refresh does, since the
 * mapping holds texts a person wrote.
 *
 * It runs locally, never in CI and never behind the network block of
 * the tests. Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { domainToUnicode } from 'node:url';

import { versionOf } from '../spike/00-inventory.mts';

import { formatSize } from '../spike/lib/academy.mts';
import { SpikeError } from '../spike/lib/errors.mts';
import { containsWord, type Json } from '../spike/lib/guard.mts';
import { operations } from '../spike/lib/operations.mts';
import {
  exitCodes,
  installCrashHandlers,
  type Io,
  writeError,
} from '../spike/lib/output.mts';
import { main, type ProbeDefinition } from '../spike/lib/probe.mts';
import { isObject } from '../spike/lib/spec.mts';
import {
  academyPages,
  categoryTree,
  readAcademy,
  refreshAgent,
  utcSeconds,
} from './lib/academy.mts';
import {
  documentVersionOf,
  factFileNames,
  factFileTexts,
  openApiNotice,
  operationRightsText,
  rightsText,
  writeFactFiles,
} from './lib/files.mts';
import {
  catalogOperations,
  catalogText,
  defaultCatalogFile,
  writeCatalog,
} from './lib/catalog.mts';
import {
  type AppliedMapping,
  applyMapping,
  defaultMappingFile,
  readMapping,
} from './lib/mapping.mts';
import { operationFacts } from './lib/operations.mts';
import { type RightFactEntry, rightFacts } from './lib/rights.mts';

/** The folder of the facts in the package `docs-index`. */
export const defaultDataDir = new URL(
  '../../packages/docs-index/data/',
  import.meta.url,
);

const words = [
  'refresh',
  'docs',
  'churchtoolsVersion',
  'operationen',
  'rechte',
  'ausgelassen',
  'hilfeseiten',
  'andereAbschnitte',
  'nichtOeffentlich',
  'ohneWissensbasis',
  'ohneText',
  'groessen',
  'SOURCES.json',
  'operations.json',
  'rights.json',
  'academy.json',
  'operation-rights.json',
  'geschrieben',
  'ja',
  'kategorien',
  'zuordnung',
  'mitBezeichnung',
  'mitSeiten',
  'brauchenRechte',
  'ohneRecht',
  'offen',
];

function count(
  guard: { allowFixed(...words: readonly number[]): void },
  value: number,
): number {
  // A count is made by the refresh, not taken from an answer, so it is a
  // fixed word, as the counts of the probes are. A value of the instance
  // that happens to be equal, such as the 0 of a header, does not
  // withhold it.
  guard.allowFixed(value);
  return value;
}

/**
 * Refuses facts that name the instance the refresh read from: its host
 * in ASCII and Unicode or its first label as a word, in what the files
 * took from their sources. The cleaning removes
 * hosts by their form, this check by the one host the refresh knows. It
 * names only the file, never what it found.
 *
 * @param texts - The text of each file.
 * @param origin - The origin of the instance.
 * @throws {SpikeError} If a file names the instance.
 */
export function checkInstanceHost(
  texts: Readonly<Record<string, string>>,
  origin: string,
): void {
  const host = new URL(origin).hostname.toLowerCase();
  const names = [host, domainToUnicode(host)].filter((name) => name !== '');
  const first = host.split('.')[0] ?? '';
  // Short labels and the labels of church.tools say nothing about which
  // instance it is and would stand in many texts.
  const label =
    first.length >= 4 && first !== 'church' && first !== 'tools'
      ? first
      : undefined;
  for (const [file, text] of Object.entries(texts)) {
    // Only what came from the sources: the format and the notice are
    // words of the project, and an instance may share a word with them.
    const taken = Object.fromEntries(
      Object.entries(JSON.parse(text) as Record<string, unknown>).filter(
        ([key]) => key !== 'format' && key !== 'notice',
      ),
    );
    const plain = JSON.stringify(taken).toLowerCase().replaceAll('\\.', '.');
    if (
      names.some((name) => plain.includes(name)) ||
      (label !== undefined &&
        (containsWord(plain, label) ||
          containsWord(plain, domainToUnicode(label))))
    ) {
      throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', file);
    }
  }
}

/**
 * The refresh as a run of the probes' frame, which brings the checks of
 * the environment, the token file, the state file and the guard of the
 * output.
 *
 * @param dataDir - The folder to write into, ending in `/`.
 * @param now - The clock.
 * @param mappingFile - The mapping by hand.
 * @param catalogFile - Where the generated part of the operation catalog
 *   goes, or left out to write none, as in the tests of other files.
 * @returns The definition for the frame of the probes.
 */
export function refreshDefinition(
  dataDir: URL = defaultDataDir,
  now: () => Date = () => new Date(),
  mappingFile: URL = defaultMappingFile,
  catalogFile?: URL,
): ProbeDefinition {
  return {
    name: 'docs-refresh',
    state: 'read',
    academy: true,
    academyAgent: refreshAgent,
    async run({
      client,
      guard,
      origin,
      state,
      statePath,
      academy,
    }): Promise<Json> {
      guard.allowFixed(...words);
      if (state === undefined || academy === undefined) {
        throw new SpikeError('INTERN');
      }
      if (state.version === null) {
        throw new SpikeError('DATEI', 'stateOhneVersion');
      }
      const churchToolsVersion = state.version;
      guard.allowVersion(churchToolsVersion);
      const document = state.specification;
      // The state keeps the parsed document, not the bytes of the answer,
      // so the hash is taken over its compact JSON: the same document
      // gives the same hash. 00-inventory writes the state once, right
      // after it fetched the document (ADR 0066).
      const openapi = {
        retrievedAt: utcSeconds(statSync(statePath).mtime),
        sha256: createHash('sha256')
          .update(JSON.stringify(document), 'utf8')
          .digest('hex'),
        documentVersion: documentVersionOf(document),
        churchToolsVersion,
      };
      const operationsNotice = openApiNotice(document, churchToolsVersion);
      const operationEntries = operationFacts(document);

      // The rights carry the version of the state. If the instance has
      // moved on since 00-inventory, the document is old as well.
      const info = await client.get({ path: operations.info.template });
      if (info.status !== 200 || versionOf(info.body) !== churchToolsVersion) {
        throw new SpikeError('DATEI', 'stateVeraltet');
      }
      const permissionsAt = utcSeconds(now());
      const answer = await client.get({
        path: operations.permissionsGlobal.template,
      });
      if (answer.status !== 200 || answer.kind !== 'JSON') {
        throw new SpikeError('ANTWORT_UNGUELTIG', 'quelleUngueltig', 'rights');
      }
      const rights = rightFacts(answer.body);
      // The hash covers what rights.json publishes from the answer, not the
      // whole answer: with its structure public, a hash of the answer would
      // let anyone try the few values the account holds, such as IDs of the
      // instance. Labels and pages come from the mapping, not from this
      // source, so the hash stays when only the mapping changes.
      const permissions = {
        retrievedAt: permissionsAt,
        sha256: createHash('sha256')
          .update(JSON.stringify(rights.entries), 'utf8')
          .digest('hex'),
        churchToolsVersion,
      };

      const read = await readAcademy(academy, now);
      const pages = academyPages(read);
      // The mapping last, against the facts just made, so that a page
      // whose text no longer holds a label stops the run before it writes.
      const mapped = applyMapping(
        readMapping(readFileSync(mappingFile, 'utf8')),
        {
          rights: rights.entries,
          operationIds: operationEntries.map((entry) =>
            String(entry['operationId']),
          ),
          academy: pages.entries,
        },
      );
      const texts = factFileTexts({
        operations: operationEntries,
        rights: mapped.rights,
        academy: pages.entries,
        operationRights: mapped.operationRights,
        operationsNotice,
        openapi,
        permissions,
        academyOrigin: { retrievedAt: read.retrievedAt, pages: pages.fetched },
      });
      checkInstanceHost(texts, origin);
      // The catalog is made before anything is written, so that an
      // operation it cannot take stops the run with no file changed.
      const catalog = catalogText(catalogOperations(operationEntries));
      writeFactFiles(texts, dataDir);
      if (catalogFile !== undefined) writeCatalog(catalog, catalogFile);

      const sizes = Object.fromEntries(
        Object.entries(texts).map(([name, text]) => {
          const size = formatSize(Buffer.byteLength(text, 'utf8'));
          guard.allowFixed(size);
          return [name, size];
        }),
      );
      return {
        refresh: 'docs',
        churchtoolsVersion: churchToolsVersion,
        operationen: count(guard, operationEntries.length),
        rechte: {
          geschrieben: count(guard, rights.entries.length),
          ausgelassen: count(guard, rights.skipped),
        },
        hilfeseiten: {
          geschrieben: count(guard, pages.entries.length),
          andereAbschnitte: count(guard, pages.otherSections),
          nichtOeffentlich: count(guard, pages.notPublic),
          ohneWissensbasis: count(guard, pages.withoutBase),
          ohneText: count(guard, pages.withoutText),
        },
        zuordnung: mappingCounts(mapped, (value) => count(guard, value)),
        groessen: sizes,
      };
    },
  };
}

function mappingCounts(
  mapped: AppliedMapping,
  counted: (value: number) => number = (value) => value,
): Record<string, number> {
  const entries = mapped.operationRights;
  return {
    mitBezeichnung: counted(
      mapped.rights.filter((right) => right.label !== undefined).length,
    ),
    mitSeiten: counted(
      mapped.rights.filter((right) => right.pages.length > 0).length,
    ),
    brauchenRechte: counted(entries.filter((entry) => 'needs' in entry).length),
    ohneRecht: counted(entries.filter((entry) => 'none' in entry).length),
    offen: counted(entries.filter((entry) => 'open' in entry).length),
  };
}

// A file under data/ as JSON, or the place of the mistake. They are
// checked facts, written by an earlier refresh.
function dataEntries(dataDir: URL, name: string): readonly unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(new URL(name, dataDir), 'utf8'));
  } catch {
    throw new SpikeError('DATEI', 'zuordnungUngueltig', `data.${name}`);
  }
  const entries = isObject(json) ? json['entries'] : undefined;
  if (!Array.isArray(entries) || !entries.every(isObject)) {
    throw new SpikeError('DATEI', 'zuordnungUngueltig', `data.${name}`);
  }
  return entries;
}

function field(entry: unknown, key: string, name: string): string {
  const value = isObject(entry) ? entry[key] : undefined;
  if (typeof value !== 'string') {
    throw new SpikeError('DATEI', 'zuordnungUngueltig', `data.${name}`);
  }
  return value;
}

/**
 * Applies the mapping to the facts under `data/` without reading any
 * source, and writes `rights.json` and `operation-rights.json` anew.
 *
 * @param dataDir - The folder of the facts, ending in `/`.
 * @param mappingFile - The mapping by hand.
 * @param origin - The instance whose name the files must not hold, if
 *   one is known.
 * @returns The counts of what it wrote.
 * @throws {SpikeError} `DATEI` if a file or the mapping does not fit,
 *   `ANTWORT_UNGUELTIG` if a file names the instance.
 */
export function refreshMapping(
  dataDir: URL = defaultDataDir,
  mappingFile: URL = defaultMappingFile,
  origin?: string,
): Record<string, unknown> {
  const rights: RightFactEntry[] = dataEntries(
    dataDir,
    factFileNames.rights,
  ).map((entry) => {
    const kind = field(entry, 'kind', factFileNames.rights);
    if (kind !== 'boolean' && kind !== 'list') {
      throw new SpikeError('DATEI', 'zuordnungUngueltig', 'data.rights.json');
    }
    return {
      module: field(entry, 'module', factFileNames.rights),
      name: field(entry, 'name', factFileNames.rights),
      kind,
      pages: [],
    };
  });
  const mapped = applyMapping(readMapping(readFileSync(mappingFile, 'utf8')), {
    rights,
    operationIds: dataEntries(dataDir, factFileNames.operations).map((entry) =>
      field(entry, 'operationId', factFileNames.operations),
    ),
    academy: dataEntries(dataDir, factFileNames.academy).map((entry) => ({
      path: field(entry, 'path', factFileNames.academy),
      text: field(entry, 'text', factFileNames.academy),
    })),
  });
  const texts = {
    [factFileNames.rights]: rightsText(mapped.rights),
    [factFileNames.operationRights]: operationRightsText(
      mapped.operationRights,
    ),
  };
  if (origin !== undefined) {
    checkInstanceHost(texts, origin);
  }
  writeFactFiles(texts, dataDir);
  return { refresh: 'zuordnung', zuordnung: mappingCounts(mapped) };
}

/**
 * Runs {@link refreshMapping} and prints its counts, or the code of an
 * error and its hint.
 *
 * @param io - Where to write.
 * @param dataDir - The folder of the facts.
 * @param mappingFile - The mapping by hand.
 * @param env - The environment, for `ECCLIUM_SPIKE_BASE_URL`.
 * @returns The exit code.
 */
export function mainMapping(
  io: Io,
  dataDir: URL = defaultDataDir,
  mappingFile: URL = defaultMappingFile,
  env: Readonly<Record<string, string | undefined>> = {},
): number {
  try {
    const base = env['ECCLIUM_SPIKE_BASE_URL'];
    let origin: string | undefined;
    if (base !== undefined && base !== '') {
      let url: URL | undefined;
      try {
        url = new URL(base);
      } catch {
        url = undefined;
      }
      if (url?.protocol !== 'https:') {
        throw new SpikeError('KONFIGURATION', 'basisUrlUngueltig');
      }
      origin = url.origin;
    }
    const counts = refreshMapping(dataDir, mappingFile, origin);
    io.stdout(`${JSON.stringify(counts, null, 2)}\n`);
    return exitCodes.ok;
  } catch (error) {
    return writeError(error, io);
  }
}

/**
 * Writes the generated part of the operation catalog from
 * `operations.json` under `data/` without reading any source, and prints
 * how many operations it holds, or the code of an error and its hint.
 *
 * @param io - Where to write.
 * @param dataDir - The folder of the facts.
 * @param catalogFile - Where the generated part goes.
 * @returns The exit code.
 */
export function mainCatalog(
  io: Io,
  dataDir: URL = defaultDataDir,
  catalogFile: URL = defaultCatalogFile,
): number {
  try {
    const operations = catalogOperations(
      dataEntries(dataDir, factFileNames.operations),
    );
    writeCatalog(catalogText(operations), catalogFile);
    io.stdout(
      `${JSON.stringify({ refresh: 'katalog', operationen: operations.length }, null, 2)}\n`,
    );
    return exitCodes.ok;
  } catch (error) {
    return writeError(error, io);
  }
}

/**
 * Lists the categories of the Academy by section and writes nothing.
 *
 * @param now - The clock.
 * @returns The definition for the frame of the probes.
 */
export function categoriesDefinition(
  now: () => Date = () => new Date(),
): ProbeDefinition {
  return {
    name: 'docs-kategorien',
    state: 'read',
    academy: true,
    academyAgent: refreshAgent,
    async run({ guard, academy }): Promise<Json> {
      guard.allowFixed('refresh', 'kategorien', '(ohne Form eines Slugs)');
      if (academy === undefined) {
        throw new SpikeError('INTERN');
      }
      const read = await readAcademy(academy, now, false);
      const tree = categoryTree(read);
      const shown = (slug: string): string => {
        // Slugs are public words of the Academy. One with another form,
        // such as a percent-code, is only counted.
        try {
          guard.allowPublic(slug);
          return slug;
        } catch {
          return '(ohne Form eines Slugs)';
        }
      };
      return {
        refresh: 'kategorien',
        kategorien: Object.fromEntries(
          Object.entries(tree).map(([root, below]) => [
            shown(root),
            below.map(shown),
          ]),
        ),
      };
    },
  };
}

if (import.meta.main) {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  if (process.argv.includes('--nur-zuordnung')) {
    installCrashHandlers(io);
    process.exitCode = mainMapping(
      io,
      defaultDataDir,
      defaultMappingFile,
      process.env,
    );
  } else if (process.argv.includes('--nur-katalog')) {
    installCrashHandlers(io);
    process.exitCode = mainCatalog(io, defaultDataDir, defaultCatalogFile);
  } else {
    const definition = process.argv.includes('--kategorien')
      ? categoriesDefinition()
      : refreshDefinition(
          defaultDataDir,
          () => new Date(),
          defaultMappingFile,
          defaultCatalogFile,
        );
    process.exitCode = await main(definition, import.meta.url);
  }
}
