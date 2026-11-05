/**
 * Probe 12: whether the instance serves or changes a page of the wiki
 * under the path of another category.
 *
 * A page is addressed by its category and its GUID, and the API names the
 * page in an answer by both. Whether the instance checks that the GUID
 * belongs to the category of the path is not documented. If it does not,
 * a write meant for one category could reach a page of another.
 *
 * Runs only with the write account, and writes only after the guard of the
 * test environment has passed and a person has typed «ja» (ADR 0049).
 * Reads: what the guard reads, the list of the pages of the identification
 * category, the own page of the run under the path of the identification
 * category, the first page of the identification category under the path
 * of the write area, and the own page before and after the change.
 * Writes: one page in the write area with `POST`, recorded at once in the
 * write state file, and one change of exactly that page with `PATCH` under
 * the path of the identification category, where the account may not edit.
 * The other direction, a change of a page of the identification category
 * under the path of the write area, is not sent: it could change the page
 * the guard relies on.
 * Answers: for each read under a foreign path the status and, for 200,
 * whether the answer names the category of the path, the one of the page
 * or another; for the change its status, and whether the version of the
 * page rose and its text changed. It prints status codes and fixed words
 * only. 07-wiki-cleanup removes the page with the same write state file.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { SpikeError } from './lib/errors.mts';
import { pageTitlePrefix, passGate } from './lib/gate.mts';
import type { Json } from './lib/guard.mts';
import { guidPattern, pathFor, type ProbeResponse } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { dataOf, readPage } from './lib/pages.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { findOperation, isObject } from './lib/spec.mts';
import { marker } from './lib/synthetic.mts';
import { WriteStateFile, checkNewWriteState } from './lib/write-state.mts';

const words = [
  'probe',
  '12-wiki-category',
  'anlegen',
  'eigeneSeiteUnterKennkategorie',
  'kennseiteUnterSchreibbereich',
  'aendernUnterKennkategorie',
  'status',
  'kategorie',
  'Pfad',
  'Seite',
  'andere',
  'fehlt',
  'versionGestiegen',
  'textGeaendert',
  'keine Seite in der Kennkategorie',
  'ja',
  'nein',
  'unbekannt',
];

const summary =
  '12-wiki-category legt im Schreibbereich eine Seite an und ändert genau diese einmal unter dem Pfad der Kennkategorie. Eine Seite der Kennkategorie liest die Probe nur.';

// The instance gives the time of the last change in whole seconds, so two
// writes in the same second could look like one.
const pauseBeforeWrite = 1100;

const text = `# Kategorie im Pfad\n\n${marker} der Probe 12.\n`;
const changedText = `${text}\nGeändert unter dem Pfad der Kennkategorie.\n`;

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

/**
 * Says which category an answer of 200 names: the one of the path, the
 * one the page is in, another one, or none.
 *
 * @param response - The answer to a read or a change of a page.
 * @param path - The category of the path of the request.
 * @param page - The category the page is in.
 * @returns `Pfad`, `Seite`, `andere` or `fehlt`.
 * @example
 * ```ts
 * namedCategory(response, 12, 9); // 'Seite' when the answer names 9
 * ```
 */
export function namedCategory(
  response: ProbeResponse,
  path: number,
  page: number,
): string {
  const data = dataOf(response);
  const category = isObject(data) ? data['wikiCategory'] : undefined;
  const id = isObject(category) ? category['id'] : undefined;
  if (typeof id !== 'number') return 'fehlt';
  return id === path ? 'Pfad' : id === page ? 'Seite' : 'andere';
}

// The status of an answer and, for 200, the category it names.
function under(
  response: ProbeResponse,
  path: number,
  page: number,
): Record<string, Json> {
  return response.status === 200
    ? { status: 200, kategorie: namedCategory(response, path, page) }
    : { status: response.status };
}

// The GUID of the first page of a list of pages, if the list has one in the
// documented form.
function firstGuid(response: ProbeResponse): string | undefined {
  const data = dataOf(response);
  if (response.status !== 200 || !Array.isArray(data)) return undefined;
  for (const entry of data) {
    const guid = isObject(entry) ? entry['guid'] : undefined;
    if (typeof guid === 'string' && guidPattern.test(guid)) return guid;
  }
  return undefined;
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '12-wiki-category',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin, wait }): Promise<Json> {
    guard.allowFixed(...words);
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    for (const name of ['wikiPage', 'wikiCategoryPages'] as const) {
      const { method, template } = operations[name];
      if (findOperation(state.specification, method, template) === undefined) {
        throw new SpikeError('KONFIGURATION', 'leseOperationFehlt');
      }
    }
    checkNewWriteState(write.settings.writeStatePath);
    const { writer, result } = await passGate(
      { client, state },
      write.access,
      write.settings,
      {
        writes: ['wikiPageCreate', 'wikiPageUpdate'],
        ownPages: new Set(),
        summary,
      },
    );
    const area = result.writeCategory;
    const identification = result.identification;
    const file = WriteStateFile.create(
      write.settings.writeStatePath,
      origin,
      area,
    );
    let wrote = false;
    try {
      // Only read: which page of the identification category to address
      // under the path of the write area.
      const listed = await client.get({
        path: pathFor(operations.wikiCategoryPages.template, identification),
      });
      guard.allowFixed(listed.status);
      const foreignPage = firstGuid(listed);

      await wait(pauseBeforeWrite);
      wrote = true;
      const created = await writer.send({
        operation: 'wikiPageCreate',
        parameters: [area],
        body: {
          title: `${pageTitlePrefix}-${file.run}-kategorie`,
          text,
          isMarkdown: true,
        },
      });
      guard.allowFixed(created.status);
      const data = dataOf(created);
      const guid = isObject(data) ? data['guid'] : undefined;
      if (typeof guid !== 'string' || !guidPattern.test(guid)) {
        if (created.status >= 200 && created.status < 300) {
          // A page the instance names no GUID for cannot be removed through
          // the API, so the run stops here.
          throw new SpikeError('ANTWORT_UNGUELTIG');
        }
        return {
          probe: '12-wiki-category',
          anlegen: { status: created.status },
        };
      }
      file.addPage(guid, 'kategorie');

      const ownRead = await client.get({
        path: pathFor(operations.wikiPage.template, identification, guid),
      });
      guard.allowFixed(ownRead.status);
      let foreignRead: Json = 'keine Seite in der Kennkategorie';
      if (foreignPage !== undefined) {
        const read = await client.get({
          path: pathFor(operations.wikiPage.template, area, foreignPage),
        });
        guard.allowFixed(read.status);
        foreignRead = under(read, area, identification);
      }

      const before = await readPage(client, area, guid);
      await wait(pauseBeforeWrite);
      const changed = await writer.send({
        operation: 'wikiPageUpdate',
        parameters: [identification, guid],
        body: { text: changedText },
      });
      guard.allowFixed(changed.status);
      const after = await readPage(client, area, guid);
      guard.allowFixed(before.status, after.status);
      const readable =
        before.status === 200 &&
        after.status === 200 &&
        before.version !== undefined &&
        after.version !== undefined &&
        before.text !== undefined &&
        after.text !== undefined;
      return {
        probe: '12-wiki-category',
        anlegen: { status: created.status },
        eigeneSeiteUnterKennkategorie: under(ownRead, identification, area),
        kennseiteUnterSchreibbereich: foreignRead,
        aendernUnterKennkategorie: {
          ...under(changed, identification, area),
          versionGestiegen: readable
            ? yesNo((after.version ?? 0) > (before.version ?? 0))
            : 'unbekannt',
          textGeaendert: readable
            ? yesNo(after.text !== before.text)
            : 'unbekannt',
        },
      };
    } catch (error) {
      // Only after the create was sent is the state of the write area open.
      if (!wrote) {
        throw error;
      }
      throw error instanceof SpikeError
        ? new SpikeError(error.code, 'schreibenAbgebrochen')
        : new SpikeError('INTERN', 'schreibenAbgebrochen');
    } finally {
      file.close();
    }
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
