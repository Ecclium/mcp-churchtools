/**
 * Probe 06: what the web editor of ChurchTools changes in a page it saves
 * without any edit.
 *
 * The maintainer opens each page for the web editor that 05-wiki-write
 * created, saves it without changing anything, and then runs this probe.
 * It runs with the write account and passes the checks of the guard that
 * need no write (ADR 0049), but it writes nothing.
 * Reads: the write state file of the run, what the guard reads, and for
 * each page for the web editor the page and the list of its versions, and
 * the version before the newest if there are two or more since 05.
 * Writes: nothing.
 * Answers: whether saving without an edit creates a version (F10), how the
 * editor changes a Markdown page (F13), and whether an HTML comment
 * survives the editor (F17). It counts the versions since 05: a second
 * save that changes nothing creates none, as F10 leads to expect. Where
 * there are two or more, it names the changes of the newest against the
 * one before. It names each change against the synthetic
 * text by kind and line, such as «Listenzeichen» or «HTML-Kommentar
 * entfernt», and says whether the page still matched that text after 05:
 * if the API itself changed the text, its changes are in the list as
 * well, and the output of 05 names them. The check code of Ecclium must
 * tolerate exactly these changes.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import {
  changeKinds,
  changeReport,
  classifyChanges,
  commentKept,
  corpusText,
  textHash,
} from './lib/corpus.mts';
import { SpikeError } from './lib/errors.mts';
import { checkInstance, pageTitlePrefix } from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import { pathFor, type Client } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { dataOf, readPage } from './lib/pages.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { findOperation, isObject } from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import { readWriteState } from './lib/write-state.mts';

const names = ['markdown1', 'markdown2', 'standardformat'] as const;

const words = [
  'probe',
  '06-wiki-editor-roundtrip',
  'seiten',
  ...names,
  'leseStatus',
  'stand',
  'versionGestiegen',
  'textGeaendert',
  'isMarkdownGelesen',
  'anzahlVersionen',
  'versionenSeit05',
  'zweitesSpeichern',
  'textGleichVorgaenger',
  'keine',
  'eins',
  'zwei',
  'mehr',
  'htmlKommentarErhalten',
  'aenderungen',
  'weitereAenderungen',
  'standNach05',
  'Korpus',
  'zeile',
  'art',
  'fehlt',
  'weicht ab',
  'ja',
  'nein',
  'wahr',
  'falsch',
  'unbekannt',
];

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

/**
 * Compares the newest version of a page with the one before it.
 *
 * @param client - The client that reads.
 * @param guard - The guard of the probe.
 * @param category - ID of the write area.
 * @param guid - GUID of the page.
 * @param version - The newest version.
 * @param text - Its text.
 * @returns Whether the text equals that of the version before, and if not,
 *   the kinds of change by line of the version before.
 */
async function secondSave(
  client: Client,
  guard: Guard,
  category: number,
  guid: string,
  version: number,
  text: string,
): Promise<Json> {
  const response = await client.get({
    path: pathFor(
      operations.wikiPageVersion.template,
      category,
      guid,
      version - 1,
    ),
  });
  guard.allowFixed(response.status);
  const data = dataOf(response);
  const previous = isObject(data) ? data['text'] : undefined;
  if (response.status !== 200 || typeof previous !== 'string') {
    return { leseStatus: response.status };
  }
  return previous === text
    ? { textGleichVorgaenger: 'ja' }
    : {
        textGleichVorgaenger: 'nein',
        ...changeReport(guard, classifyChanges(previous, text)),
      };
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '06-wiki-editor-roundtrip',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin }): Promise<Json> {
    guard.allowFixed(...words, ...countClasses, ...changeKinds);
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    for (const name of [
      'wikiPage',
      'wikiPageVersions',
      'wikiPageVersion',
    ] as const) {
      const { method, template } = operations[name];
      if (findOperation(state.specification, method, template) === undefined) {
        throw new SpikeError('KONFIGURATION', 'leseOperationFehlt');
      }
    }
    const written = readWriteState(
      write.settings.writeStatePath,
      origin,
      write.settings.writeCategory,
    );
    guard.blockAll(written);
    const result = await checkInstance({ client, state }, write.settings, {
      writes: [],
      ownPages: new Set(written.pages.map((page) => page.guid)),
      ownTitles: `${pageTitlePrefix}-${written.run}-`,
    });
    const pages: Record<string, Json> = {};
    for (const name of names) {
      const page = written.pages.find((entry) => entry.role === name);
      const baseline = page?.baseline;
      if (page === undefined || baseline === undefined) {
        pages[name] = { stand: 'fehlt' };
        continue;
      }
      const view = await readPage(client, result.writeCategory, page.guid);
      guard.allowFixed(view.status);
      if (view.status !== 200) {
        pages[name] = { leseStatus: view.status };
        continue;
      }
      const report: Record<string, Json> = {
        versionGestiegen:
          view.version === undefined
            ? 'unbekannt'
            : yesNo(view.version > baseline.version),
        isMarkdownGelesen:
          view.isMarkdown === undefined
            ? 'fehlt'
            : view.isMarkdown
              ? 'wahr'
              : 'falsch',
        anzahlVersionen:
          view.versionCount === undefined
            ? 'unbekannt'
            : countClass(view.versionCount),
        standNach05:
          baseline.textHash === textHash(corpusText) ? 'Korpus' : 'weicht ab',
      };
      if (view.version !== undefined) {
        const since = view.version - baseline.version;
        report['versionenSeit05'] =
          since <= 0
            ? 'keine'
            : since === 1
              ? 'eins'
              : since === 2
                ? 'zwei'
                : 'mehr';
        // Two saves without an edit that each made a version: compare the
        // newest version with the one before it, so a second save that
        // changes the text again shows its own changes.
        if (since >= 2 && typeof view.text === 'string') {
          report['zweitesSpeichern'] = await secondSave(
            client,
            guard,
            result.writeCategory,
            page.guid,
            view.version,
            view.text,
          );
        }
      }
      pages[name] =
        typeof view.text === 'string'
          ? {
              ...report,
              textGeaendert: yesNo(textHash(view.text) !== baseline.textHash),
              htmlKommentarErhalten: yesNo(commentKept(view.text)),
              ...changeReport(guard, classifyChanges(corpusText, view.text)),
            }
          : { ...report, textGeaendert: 'unbekannt' };
    }
    return { probe: '06-wiki-editor-roundtrip', seiten: pages };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
