/**
 * Probe 07: removes the pages of one run of 05-wiki-write.
 *
 * Runs only with the write account, and deletes only after the guard of
 * the test environment has passed and a person has typed «ja» (ADR 0049).
 * A deletion removes a page with all its versions and cannot be undone, so
 * the README asks to run 07 only after the outputs of 05 and 06 are
 * reviewed.
 * Reads: the write state file of the run, what the guard reads, and before
 * and after each deletion `GET /api/wiki/categories/{id}/pages/{guid}`.
 * Deletes: `DELETE /api/wiki/categories/{id}/pages/{guid}`, for each GUID
 * from the write state file, and for each page of the write area whose
 * title carries the prefix and the tag of this run: such a page can exist
 * without its GUID in the file if the answer to its create was lost. Each
 * page goes only if a read shows it in the write area, with that title and
 * the right to delete it. The automatic page of the area is never touched.
 * Answers: whether the documented deletion works, and whether a deleted
 * page is gone afterwards. A page that is already gone counts as removed,
 * so 07 can run again after an interruption.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { SpikeError } from './lib/errors.mts';
import { pageTitlePrefix, passGate } from './lib/gate.mts';
import type { Json } from './lib/guard.mts';
import { pathFor } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { dataOf } from './lib/pages.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { findOperation, isObject } from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import { readWriteState } from './lib/write-state.mts';

const words = [
  'probe',
  '07-wiki-cleanup',
  'seiten',
  'ergebnis',
  'gelöscht',
  'schon gelöscht',
  'noch vorhanden',
  'fehlgeschlagen',
  'übersprungen',
  'status',
  'danachNichtGefunden',
  'gefundenUeber',
  'Titel',
  'unbekannt',
  'anzahl',
  'ja',
  'nein',
];

const summary =
  '07-wiki-cleanup löscht im Schreibbereich die Seiten dieses Laufs, endgültig und mit allen Versionen. Die Seite «main» bleibt.';

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '07-wiki-cleanup',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin }): Promise<Json> {
    guard.allowFixed(...words, ...countClasses);
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    const { method, template } = operations.wikiPage;
    if (findOperation(state.specification, method, template) === undefined) {
      throw new SpikeError('KONFIGURATION', 'leseOperationFehlt');
    }
    const written = readWriteState(
      write.settings.writeStatePath,
      origin,
      write.settings.writeCategory,
    );
    guard.blockAll(written);
    const titleStart = `${pageTitlePrefix}-${written.run}-`;
    const recorded = new Set(written.pages.map((page) => page.guid));
    const { writer, result } = await passGate(
      { client, state },
      write.access,
      write.settings,
      {
        writes: ['wikiPageDelete'],
        ownPages: recorded,
        ownTitles: titleStart,
        summary,
      },
    );
    const category = result.writeCategory;
    const byTitle = result.pages
      .filter((page) => page.title.startsWith(titleStart))
      .map((page) => page.guid)
      .filter((guid) => !recorded.has(guid));
    const pages: Json[] = [];
    let deletedOnce = false;
    try {
      for (const guid of [...recorded, ...byTitle]) {
        const found: Record<string, Json> = recorded.has(guid)
          ? {}
          : { gefundenUeber: 'Titel' };
        const path = pathFor(operations.wikiPage.template, category, guid);
        const before = await client.get({ path });
        guard.allowFixed(before.status);
        if (before.status === 404) {
          pages.push({ ergebnis: 'schon gelöscht', ...found });
          continue;
        }
        const data = dataOf(before);
        const area = isObject(data) ? data['wikiCategory'] : undefined;
        const rights = isObject(data) ? data['permissions'] : undefined;
        if (
          before.status !== 200 ||
          !isObject(data) ||
          data['guid'] !== guid ||
          !isObject(area) ||
          area['id'] !== category ||
          typeof data['title'] !== 'string' ||
          !data['title'].startsWith(titleStart) ||
          !isObject(rights) ||
          rights['canDelete'] !== true
        ) {
          pages.push({
            ergebnis: 'übersprungen',
            status: before.status,
            ...found,
          });
          continue;
        }
        deletedOnce = true;
        const deleted = await writer.send({
          operation: 'wikiPageDelete',
          parameters: [category, guid],
        });
        guard.allowFixed(deleted.status);
        const after = await client.get({ path });
        guard.allowFixed(after.status);
        // Only 404 says the page is gone and only 200 that it is still
        // there; any other answer leaves it open.
        const remaining =
          after.status === 404
            ? 'ja'
            : after.status === 200
              ? 'nein'
              : 'unbekannt';
        pages.push({
          ergebnis:
            deleted.status < 200 || deleted.status >= 300
              ? 'fehlgeschlagen'
              : remaining === 'ja'
                ? 'gelöscht'
                : remaining === 'nein'
                  ? 'noch vorhanden'
                  : 'unbekannt',
          status: deleted.status,
          danachNichtGefunden: remaining,
          ...found,
        });
      }
    } catch (error) {
      // Only after a deletion was sent is its outcome possibly unknown.
      if (!deletedOnce) {
        throw error;
      }
      throw error instanceof SpikeError
        ? new SpikeError(error.code, 'schreibenAbgebrochen')
        : new SpikeError('INTERN', 'schreibenAbgebrochen');
    }
    return {
      probe: '07-wiki-cleanup',
      anzahl: countClass(recorded.size + byTitle.length),
      seiten: pages,
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
