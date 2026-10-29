/**
 * `pnpm docs:refresh`: writes the facts of the docs index from their
 * sources into `packages/docs-index/data/` (ADR 0027, ADR 0066).
 *
 * Reads: the OpenAPI document from the state file of 00-inventory,
 * without a request; `GET /api/permissions/global` with the account of
 * the token file; and the German help pages of the Academy through the
 * REST interface of WordPress, with its own User-Agent, after
 * `robots.txt` and with a pause between two requests.
 * Writes: the four files under `packages/docs-index/data/`, only once
 * all of them are made. No raw source is written anywhere.
 * Prints: counts, sizes and fixed words, never a text, a link or a host
 * of a source. The checks of the package then read the files: run
 * `pnpm build` and `pnpm check` afterwards.
 *
 * With `--kategorien` it reads only the categories of the Academy and
 * prints their slugs by section, to decide which categories outside the
 * sections the index takes. It writes nothing then.
 *
 * It runs locally, never in CI and never behind the network block of
 * the tests. Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { domainToUnicode } from 'node:url';

import { versionOf } from '../spike/00-inventory.mts';

import { formatSize } from '../spike/lib/academy.mts';
import { SpikeError } from '../spike/lib/errors.mts';
import { containsWord, type Json } from '../spike/lib/guard.mts';
import { operations } from '../spike/lib/operations.mts';
import { main, type ProbeDefinition } from '../spike/lib/probe.mts';
import {
  academyPages,
  categoryTree,
  readAcademy,
  refreshAgent,
  utcSeconds,
} from './lib/academy.mts';
import {
  documentVersionOf,
  factFileTexts,
  openApiNotice,
  writeFactFiles,
} from './lib/files.mts';
import { operationFacts } from './lib/operations.mts';
import { rightFacts } from './lib/rights.mts';

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
  'geschrieben',
  'ja',
  'kategorien',
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
 * Refuses texts that name the instance the refresh read from: its host
 * in ASCII and Unicode or its first label as a word. The cleaning removes
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
    const plain = text.toLowerCase().replaceAll('\\.', '.');
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
 * @returns The definition for the frame of the probes.
 */
export function refreshDefinition(
  dataDir: URL = defaultDataDir,
  now: () => Date = () => new Date(),
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
      // The hash covers what rights.json publishes, not the whole answer:
      // with its structure public, a hash of the answer would let anyone
      // try the few values the account holds, such as IDs of the instance.
      const permissions = {
        retrievedAt: permissionsAt,
        sha256: createHash('sha256')
          .update(JSON.stringify(rights.entries), 'utf8')
          .digest('hex'),
        churchToolsVersion,
      };

      const read = await readAcademy(academy, now);
      const pages = academyPages(read);
      const texts = factFileTexts({
        operations: operationEntries,
        rights: rights.entries,
        academy: pages.entries,
        operationsNotice,
        openapi,
        permissions,
        academyOrigin: { retrievedAt: read.retrievedAt, pages: pages.fetched },
      });
      checkInstanceHost(texts, origin);
      writeFactFiles(texts, dataDir);

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
        groessen: sizes,
      };
    },
  };
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
  const definition = process.argv.includes('--kategorien')
    ? categoriesDefinition()
    : refreshDefinition();
  process.exitCode = await main(definition, import.meta.url);
}
