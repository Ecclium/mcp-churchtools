/**
 * Probe 07: removes the pages of one run of 05-wiki-write.
 *
 * Runs only with the write account, and deletes only after the guard of
 * the test environment has passed and a person has typed «ja» (ADR 0049).
 * A deletion removes a page with all its versions and cannot be undone, so
 * the README asks to run 07 only after the outputs of 05 and 06 are
 * reviewed.
 * Reads: the write state file of the run, what the guard reads, and before
 * each deletion `GET /api/wiki/categories/{id}/pages/{guid}`.
 * Deletes: `DELETE /api/wiki/categories/{id}/pages/{guid}`, only for a
 * GUID from the write state file, and only if the page lies in the write
 * area, carries the prefix and the tag of the run in its title, and may be
 * deleted. The automatic page of the area is never touched.
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
import { pathFor, type ProbeResponse } from './lib/http.mts';
import { operations } from './lib/operations.mts';
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
  'übersprungen',
  'status',
  'danachNichtGefunden',
  'anzahl',
  'ja',
  'nein',
];

const summary =
  '07-wiki-cleanup löscht im Schreibbereich die Seiten aus der Schreib-State-Datei, endgültig und mit allen Versionen. Die Seite «main» bleibt.';

function dataOf(response: ProbeResponse): unknown {
  return isObject(response.body) ? response.body['data'] : undefined;
}

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
    const { writer, result } = await passGate(
      { client, state },
      write.access,
      write.settings,
      {
        writes: ['wikiPageDelete'],
        ownPages: new Set(written.pages.map((page) => page.guid)),
        summary,
      },
    );
    const category = result.writeCategory;
    const titleStart = `${pageTitlePrefix}-${written.run}-`;
    const pages: Json[] = [];
    try {
      for (const { guid } of written.pages) {
        const path = pathFor(operations.wikiPage.template, category, guid);
        const before = await client.get({ path });
        guard.allowFixed(before.status);
        if (before.status === 404) {
          pages.push({ ergebnis: 'schon gelöscht' });
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
          pages.push({ ergebnis: 'übersprungen', status: before.status });
          continue;
        }
        const deleted = await writer.send({
          operation: 'wikiPageDelete',
          parameters: [category, guid],
        });
        guard.allowFixed(deleted.status);
        const after = await client.get({ path });
        pages.push({
          ergebnis:
            deleted.status >= 200 && deleted.status < 300
              ? 'gelöscht'
              : 'übersprungen',
          status: deleted.status,
          danachNichtGefunden: after.status === 404 ? 'ja' : 'nein',
        });
      }
    } catch (error) {
      throw error instanceof SpikeError
        ? new SpikeError(error.code, 'schreibenAbgebrochen')
        : new SpikeError('INTERN', 'schreibenAbgebrochen');
    }
    return {
      probe: '07-wiki-cleanup',
      anzahl: countClass(written.pages.length),
      seiten: pages,
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
