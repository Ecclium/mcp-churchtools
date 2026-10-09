/**
 * Probe 05: wiki pages written through the API, and what the instance
 * makes of them.
 *
 * Runs only with the write account, and writes only after the guard of the
 * test environment has passed and a person has typed «ja» (ADR 0049).
 * Writes, all in the write area:
 * - `POST /api/wiki/categories/{id}/pages`: two pages with the synthetic
 *   text in Markdown and one with the same text without `isMarkdown`, all
 *   three left alone afterwards for the web editor; a fourth page for the
 *   cases below; once more the title of the fourth page;
 * - `PATCH /api/wiki/categories/{id}/pages/{guid}`, only on the fourth
 *   page: the same text, a new text, no text, two changes in a row, a stale
 *   `version` in the body, a stale `If-Match`, an `If-Unmodified-Since` in
 *   the past, and a `title` in the body, which the document does not
 *   declare.
 * No request carries a CSRF token or a cookie.
 * Reads: what the guard reads, and after each write the page and its list
 * of versions.
 * Records: every page the instance creates, in the write state file, at
 * once. After an error that follows a write, it sends nothing more.
 * Answers: whether a write creates a version and when (F10), whether the
 * API honours a version condition (F11), whether a client with a login
 * token and no session needs a CSRF token (F12), which format a new page
 * gets (F16), and whether an HTML comment survives the API (F17). It
 * prints only status codes, ja or nein, wahr or falsch, count classes, and
 * the kinds of change with the line numbers of the synthetic text.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import {
  changeKinds,
  classifyChanges,
  corpusText,
  textHash,
} from './lib/corpus.mts';
import { SpikeError } from './lib/errors.mts';
import { pageTitlePrefix, passGate } from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import {
  guidPattern,
  pastDate,
  staleEntityTag,
  type Client,
  type ProbeResponse,
  type WriteClient,
  type WriteRequest,
} from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { dataOf, readPage, type PageView } from './lib/pages.mts';
import { describeResponse } from './lib/report.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type JsonObject,
} from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import {
  WriteStateFile,
  checkNewWriteState,
  type PageRole,
} from './lib/write-state.mts';

const words = [
  'probe',
  '05-wiki-write',
  'seiten',
  'markdown1',
  'markdown2',
  'standardformat',
  'faelle',
  'anlegen',
  'antwort',
  'leseStatus',
  'isMarkdownGesendet',
  'isMarkdownGelesen',
  'versionEins',
  'anzahlVersionen',
  'textGleich',
  'htmlKommentarErhalten',
  'aenderungen',
  'zeile',
  'art',
  'onStartpageFalsch',
  'identifierGleichGuid',
  'gleicherText',
  'neuerText',
  'ohneText',
  'zweimalHintereinander',
  'veralteteVersion',
  'ifMatch',
  'ifUnmodifiedSince',
  'titelImBody',
  'doppelterTitel',
  'statusErste',
  'statusZweite',
  'versionGestiegen',
  'versionDifferenz',
  'aenderungsdatumGeaendert',
  'textUebernommen',
  'titelGeaendert',
  'angelegt',
  'nicht ausgeführt',
  'ja',
  'nein',
  'wahr',
  'falsch',
  'fehlt',
  'unbekannt',
  'keine',
  'eins',
  'zwei',
  'mehr',
];

const summary =
  '05-wiki-write legt im Schreibbereich vier Seiten an, ändert die vierte mehrmals und legt einmal einen doppelten Titel an.';

/** A page the probe asked the instance to create. */
interface Created {
  readonly response: ProbeResponse;
  readonly guid: string | undefined;
}

/** Everything the steps of the probe share. */
interface Run {
  readonly client: Client;
  readonly writer: WriteClient;
  readonly guard: Guard;
  readonly schemas: Schemas;
  readonly createOperation: JsonObject | undefined;
  readonly updateOperation: JsonObject | undefined;
  readonly category: number;
  readonly file: WriteStateFile;
}

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');
const truth = (value: boolean | undefined): string =>
  value === undefined ? 'fehlt' : value ? 'wahr' : 'falsch';
const succeeded = (response: ProbeResponse): boolean =>
  response.status >= 200 && response.status < 300;

/**
 * Takes the GUID of a page from an answer of the instance.
 *
 * @param response - Answer to a create or a read.
 * @returns The GUID, if the answer has one in the documented form.
 * @example
 * ```ts
 * guidOf(response); // '0f8fad5b-d9cb-469f-a165-70867728950e'
 * ```
 */
export function guidOf(response: ProbeResponse): string | undefined {
  const data = dataOf(response);
  const guid = isObject(data) ? data['guid'] : undefined;
  return typeof guid === 'string' && guidPattern.test(guid) ? guid : undefined;
}

function rose(before: number | undefined, after: number | undefined): string {
  return before === undefined || after === undefined
    ? 'unbekannt'
    : yesNo(after > before);
}

function changed(
  before: string | undefined,
  after: string | undefined,
): string {
  return before === undefined || after === undefined
    ? 'unbekannt'
    : yesNo(after !== before);
}

function difference(before: PageView, after: PageView): string {
  if (before.version === undefined || after.version === undefined) {
    return 'unbekannt';
  }
  const steps = after.version - before.version;
  return steps <= 0
    ? 'keine'
    : steps === 1
      ? 'eins'
      : steps === 2
        ? 'zwei'
        : 'mehr';
}

function describe(
  run: Run,
  response: ProbeResponse,
  operation: JsonObject | undefined,
): Json {
  return describeResponse(response, {
    guard: run.guard,
    schemas: run.schemas,
    operation,
  });
}

async function create(
  run: Run,
  title: string,
  body: Readonly<Record<string, Json>>,
  role: PageRole,
): Promise<Created> {
  const response = await run.writer.send({
    operation: 'wikiPageCreate',
    parameters: [run.category],
    body: { title, ...body },
  });
  run.guard.allowFixed(response.status);
  const guid = guidOf(response);
  if (guid !== undefined) {
    run.file.addPage(guid, role);
  } else if (succeeded(response)) {
    // The instance says it created a page but names no GUID. Nobody could
    // remove that page through the API, so the run stops here.
    throw new SpikeError('ANTWORT_UNGUELTIG');
  }
  return { response, guid };
}

function pageReport(
  run: Run,
  created: Created,
  view: PageView | undefined,
  sentMarkdown: boolean,
  describeCreate: boolean,
): Json {
  const anlegen: Record<string, Json> = { status: created.response.status };
  if (describeCreate || !succeeded(created.response)) {
    anlegen['antwort'] = describe(run, created.response, run.createOperation);
  }
  const result: Record<string, Json> = {
    anlegen,
    isMarkdownGesendet: sentMarkdown ? 'wahr' : 'fehlt',
  };
  if (view === undefined) {
    return result;
  }
  run.guard.allowFixed(view.status);
  if (view.status !== 200) {
    return { ...result, leseStatus: view.status };
  }
  const text = view.text ?? '';
  const changes = text === corpusText ? [] : classifyChanges(corpusText, text);
  run.guard.allowFixed(...changes.map((change) => change.zeile));
  return {
    ...result,
    isMarkdownGelesen: truth(view.isMarkdown),
    versionEins:
      view.version === undefined ? 'unbekannt' : yesNo(view.version === 1),
    anzahlVersionen: countClass(view.versionCount ?? 0),
    textGleich: yesNo(view.text === corpusText),
    htmlKommentarErhalten: yesNo(text.includes('<!--')),
    aenderungen: changes.map((change) => ({
      zeile: change.zeile,
      art: change.art,
    })),
    onStartpageFalsch:
      view.onStartpage === undefined ? 'fehlt' : yesNo(!view.onStartpage),
    identifierGleichGuid: yesNo(view.identifier === view.guid),
  };
}

async function runCases(
  run: Run,
  guid: string,
  titleOf: (suffix: string) => string,
): Promise<Json> {
  let before = await readPage(run.client, run.category, guid);
  const update = async (
    request: Pick<WriteRequest, 'body' | 'precondition'>,
    expectedText?: string,
  ): Promise<Record<string, Json>> => {
    const response = await run.writer.send({
      operation: 'wikiPageUpdate',
      parameters: [run.category, guid],
      ...request,
    });
    run.guard.allowFixed(response.status);
    const after = await readPage(run.client, run.category, guid);
    const result: Record<string, Json> = {
      status: response.status,
      versionGestiegen: rose(before.version, after.version),
      aenderungsdatumGeaendert: changed(
        before.modifiedDate,
        after.modifiedDate,
      ),
    };
    if (expectedText !== undefined) {
      result['textUebernommen'] = yesNo(after.text === expectedText);
    }
    if (request.body !== undefined && 'title' in request.body) {
      result['titelGeaendert'] = changed(before.title, after.title);
    }
    if (!succeeded(response)) {
      result['antwort'] = describe(run, response, run.updateOperation);
    }
    before = after;
    return result;
  };
  const marked = (label: string): string => `${corpusText}\nFall: ${label}`;

  const gleicherText = await update({ body: { text: corpusText } }, corpusText);
  const neuerText = await update(
    { body: { text: marked('neuer Text') } },
    marked('neuer Text'),
  );
  const ohneText = await update({ body: { isMarkdown: true } });
  const start = before;
  const first = await update({ body: { text: marked('erste von zwei') } });
  const second = await update(
    { body: { text: marked('zweite von zwei') } },
    marked('zweite von zwei'),
  );
  const zweimalHintereinander: Json = {
    statusErste: first['status'] ?? 'fehlt',
    statusZweite: second['status'] ?? 'fehlt',
    versionDifferenz: difference(start, before),
    textUebernommen: second['textUebernommen'] ?? 'unbekannt',
  };
  const veralteteVersion = await update(
    { body: { text: marked('veraltete Version'), version: 1 } },
    marked('veraltete Version'),
  );
  const ifMatch = await update(
    {
      body: { text: marked('If-Match') },
      precondition: { ifMatch: staleEntityTag },
    },
    marked('If-Match'),
  );
  const ifUnmodifiedSince = await update(
    {
      body: { text: marked('If-Unmodified-Since') },
      precondition: { ifUnmodifiedSince: pastDate },
    },
    marked('If-Unmodified-Since'),
  );
  // The title keeps the prefix and the tag of the run, so 07 still knows
  // the page if the instance takes the undeclared field.
  const titelImBody = await update({ body: { title: titleOf('4-titel') } });

  const duplicate = await create(
    run,
    titleOf('4'),
    { text: marked('doppelter Titel'), isMarkdown: true },
    'faelle',
  );
  const doppelterTitel: Record<string, Json> = {
    status: duplicate.response.status,
    angelegt: yesNo(duplicate.guid !== undefined),
  };
  if (!succeeded(duplicate.response)) {
    doppelterTitel['antwort'] = describe(
      run,
      duplicate.response,
      run.createOperation,
    );
  }

  return {
    gleicherText,
    neuerText,
    ohneText,
    zweimalHintereinander,
    veralteteVersion,
    ifMatch,
    ifUnmodifiedSince,
    titelImBody,
    doppelterTitel,
  };
}

async function writeAndRead(
  run: Run,
  titleOf: (suffix: string) => string,
): Promise<Json> {
  const markdown1 = await create(
    run,
    titleOf('1'),
    { text: corpusText, isMarkdown: true },
    'editor',
  );
  const markdown2 = await create(
    run,
    titleOf('2'),
    { text: corpusText, isMarkdown: true },
    'editor',
  );
  const plain = await create(run, titleOf('3'), { text: corpusText }, 'editor');
  const cases = await create(
    run,
    titleOf('4'),
    { text: corpusText, isMarkdown: true },
    'faelle',
  );

  const views = new Map<string, PageView>();
  for (const created of [markdown1, markdown2, plain, cases]) {
    if (created.guid !== undefined) {
      views.set(
        created.guid,
        await readPage(run.client, run.category, created.guid),
      );
    }
  }
  const viewOf = (created: Created): PageView | undefined =>
    created.guid === undefined ? undefined : views.get(created.guid);

  const faelle =
    cases.guid === undefined
      ? 'nicht ausgeführt'
      : await runCases(run, cases.guid, titleOf);

  // The state of each page for the web editor, so 06 can tell the changes
  // of the editor from those of the probe.
  for (const created of [markdown1, markdown2, plain]) {
    const view = viewOf(created);
    if (created.guid !== undefined && view?.version !== undefined) {
      run.file.setBaseline(created.guid, {
        version: view.version,
        textHash: textHash(view.text ?? ''),
      });
    }
  }

  return {
    probe: '05-wiki-write',
    seiten: {
      markdown1: pageReport(run, markdown1, viewOf(markdown1), true, true),
      markdown2: pageReport(run, markdown2, viewOf(markdown2), true, false),
      standardformat: pageReport(run, plain, viewOf(plain), false, false),
      faelle: pageReport(run, cases, viewOf(cases), true, false),
    },
    faelle,
  };
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '05-wiki-write',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin }): Promise<Json> {
    guard.allowFixed(...words, ...countClasses, ...changeKinds);
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    const document = state.specification;
    for (const name of ['wikiPage', 'wikiPageVersions'] as const) {
      const { method, template } = operations[name];
      if (findOperation(document, method, template) === undefined) {
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
    const file = WriteStateFile.create(
      write.settings.writeStatePath,
      origin,
      result.writeCategory,
    );
    const run: Run = {
      client,
      writer,
      guard,
      schemas: new Schemas(document),
      createOperation: findOperation(
        document,
        'post',
        operations.wikiPageCreate.template,
      ),
      updateOperation: findOperation(
        document,
        'patch',
        operations.wikiPageUpdate.template,
      ),
      category: result.writeCategory,
      file,
    };
    try {
      return await writeAndRead(
        run,
        (suffix) => `${pageTitlePrefix}-${file.run}-${suffix}`,
      );
    } catch (error) {
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
