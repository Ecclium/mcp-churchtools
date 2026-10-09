// Runs the write probes against a synthetic instance full of canary values
// (see tests/fixtures/README.md). They must write only in the write area,
// only after «ja», record every page at once, stop after an error, and
// print no value from the instance.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probe as inventory } from '../../scripts/spike/00-inventory.mts';
import { probe as write } from '../../scripts/spike/05-wiki-write.mts';
import { probe as roundtrip } from '../../scripts/spike/06-wiki-editor-roundtrip.mts';
import { probe as cleanup } from '../../scripts/spike/07-wiki-cleanup.mts';
import {
  corpus,
  corpusText,
  textHash,
} from '../../scripts/spike/lib/corpus.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { Input } from '../../scripts/spike/lib/gate.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import { readWriteState } from '../../scripts/spike/lib/write-state.mts';
import { capture, leaks, specification, type Capture } from './support.mts';
import {
  writeInstance,
  writeOrigin,
  writeSetup,
  type WriteInstance,
  type WriteInstanceOptions,
  type WriteSetting,
} from './write-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

/** A terminal that answers «ja» and notes how many calls came before. */
function confirming(instance: WriteInstance): Input & { before: number[] } {
  const before: number[] = [];
  return {
    before,
    isTerminal: true,
    readLine: () => {
      before.push(instance.calls.length);
      return Promise.resolve('ja');
    },
  };
}

interface Run {
  readonly code: number;
  readonly output: Capture;
  readonly result: unknown;
  /** The pauses the probe asked for, in milliseconds. */
  readonly waits: readonly number[];
}

async function runOne(
  definition: ProbeDefinition,
  instance: WriteInstance,
  env: Readonly<Record<string, string | undefined>>,
  input?: Input,
): Promise<Run> {
  const output = capture();
  const waits: number[] = [];
  const code = await runProbe(definition, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    ...(input === undefined ? {} : { input }),
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
    waits,
  };
}

async function prepared(
  options: WriteInstanceOptions = {},
): Promise<{ setting: WriteSetting; instance: WriteInstance }> {
  const setting = writeSetup();
  const instance = writeInstance(setting, options);
  const run = await runOne(inventory, instance, setting.inventoryEnv);
  expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
  instance.calls.length = 0;
  return { setting, instance };
}

/** The same instance, with some answers replaced. */
function rewriting(
  instance: WriteInstance,
  change: (call: {
    method: string;
    url: URL;
    index: number;
  }) => Response | Promise<Response | undefined> | undefined,
): WriteInstance {
  let index = 0;
  return {
    ...instance,
    fetch: async (url, init) => {
      index += 1;
      const replaced = await change({
        method: init.method ?? 'GET',
        url,
        index,
      });
      if (replaced !== undefined) {
        instance.calls.push({
          method: init.method ?? 'GET',
          url,
          headers: new Headers(init.headers),
          body: typeof init.body === 'string' ? init.body : undefined,
        });
        return replaced;
      }
      return instance.fetch(url, init);
    },
  };
}

/** An object without some of its keys. */
function without(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

const refused = (status: number): Response =>
  new Response(JSON.stringify({ message: 'x' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const writes = (instance: WriteInstance): string[] =>
  instance.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => `${call.method} ${call.url.pathname}`);

const titles = (instance: WriteInstance): string[] =>
  [...instance.pages.values()].map((page) => page.title);

describe('05-wiki-write', () => {
  it('writes four pages and the cases, and prints no value of the instance', async () => {
    const { setting, instance } = await prepared();
    const input = confirming(instance);
    const run = await runOne(write, instance, setting.env, input);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);

    // Nothing but the reads of the guard before the confirmation.
    const [confirmedAt] = input.before;
    expect(confirmedAt).toBe(3);
    expect(
      instance.calls.slice(0, confirmedAt).map((call) => call.method),
    ).toEqual(['GET', 'GET', 'GET']);

    const state = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    );
    expect(state.pages.map((page) => page.role)).toEqual([
      'markdown1',
      'markdown2',
      'standardformat',
      'faelle',
    ]);
    const [first, second, third, cases] = state.pages;
    for (const page of [first, second, third]) {
      expect(page?.baseline).toEqual({
        version: 1,
        textHash: textHash(corpusText),
      });
      // The pages for the web editor stay as created.
      expect(instance.pages.get(page?.guid ?? '')?.versions).toHaveLength(1);
    }
    const area = `/api/wiki/categories/${String(setting.writeCategory)}/pages`;
    expect(writes(instance)).toEqual([
      ...Array.from({ length: 4 }, () => `POST ${area}`),
      ...Array.from({ length: 8 }, () => `PATCH ${area}/${cases?.guid ?? ''}`),
      `POST ${area}`,
      `PATCH ${area}/${cases?.guid ?? ''}`,
    ]);
    // A pause of more than a second before each write.
    expect(run.waits).toEqual(Array.from({ length: 14 }, () => 1100));
    for (const call of instance.calls) {
      expect(call.url.origin).toBe(writeOrigin);
      expect(call.headers.has('cookie')).toBe(false);
      expect(call.headers.has('csrf-token')).toBe(false);
    }

    expect(run.result).toMatchObject({
      probe: '05-wiki-write',
      seiten: {
        markdown1: {
          anlegen: { status: 201, antwort: { status: 201 } },
          isMarkdownGesendet: 'wahr',
          isMarkdownGelesen: 'wahr',
          versionEins: 'ja',
          anzahlVersionen: '1',
          textGleich: 'ja',
          htmlKommentarErhalten: 'ja',
          aenderungen: [],
          onStartpageFalsch: 'ja',
          identifierGleichGuid: 'ja',
        },
        markdown2: { anlegen: { status: 201 }, textGleich: 'ja' },
        standardformat: {
          isMarkdownGesendet: 'fehlt',
          isMarkdownGelesen: 'falsch',
        },
        faelle: { anlegen: { status: 201 } },
      },
      faelle: {
        gleicherText: {
          status: 200,
          versionGestiegen: 'nein',
          textUebernommen: 'ja',
        },
        neuerText: {
          status: 200,
          versionGestiegen: 'ja',
          textUebernommen: 'ja',
        },
        ohneText: {
          status: 200,
          versionGestiegen: 'nein',
          aenderungsdatumGeaendert: 'ja',
        },
        zweimalHintereinander: {
          statusErste: 200,
          statusZweite: 200,
          versionDifferenz: 'zwei',
          textUebernommen: 'ja',
        },
        veralteteVersion: { status: 200, textUebernommen: 'ja' },
        ifMatch: { status: 200, versionGestiegen: 'ja' },
        ifUnmodifiedSince: { status: 200, versionGestiegen: 'ja' },
        titelImBody: { status: 200, titelGeaendert: 'nein' },
        doppelterTitel: {
          status: 400,
          angelegt: 'nein',
          antwort: { status: 400 },
        },
      },
    });
  });

  it('reports an instance that honours preconditions, a title in the body, a duplicate title and unchanged text', async () => {
    const { setting, instance } = await prepared({
      honourPreconditions: true,
      honourTitle: true,
      duplicateStatus: 201,
      sameTextNewVersion: true,
    });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toMatchObject({
      faelle: {
        gleicherText: { versionGestiegen: 'ja' },
        ifMatch: {
          status: 412,
          versionGestiegen: 'nein',
          textUebernommen: 'nein',
          antwort: { status: 412 },
        },
        ifUnmodifiedSince: { status: 412, versionGestiegen: 'nein' },
        titelImBody: { titelGeaendert: 'ja' },
        doppelterTitel: { status: 201, angelegt: 'ja' },
      },
    });
    expect(
      readWriteState(setting.writeStateFile, writeOrigin, setting.writeCategory)
        .pages,
    ).toHaveLength(5);
    // 07 finds the renamed page and the duplicate by their GUIDs.
    const removed = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(removed.code, removed.output.stderr()).toBe(exitCodes.ok);
    expect(titles(instance)).toEqual(['main']);
  });

  it('stops after an error that follows a write, with every created page recorded', async () => {
    // Three reads of the guard, then the first and the second create.
    const { setting, instance } = await prepared({ failOnCall: 5 });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.network);
    expect(run.output.stdout()).toBe('');
    expect(run.output.stderr()).toContain(hints.schreibenAbgebrochen);
    expect(instance.calls).toHaveLength(5);
    expect(
      readWriteState(setting.writeStateFile, writeOrigin, setting.writeCategory)
        .pages,
    ).toHaveLength(1);

    const removed = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(removed.code, removed.output.stderr()).toBe(exitCodes.ok);
    expect(removed.result).toMatchObject({
      seiten: [
        { ergebnis: 'gelöscht', status: 204, danachNichtGefunden: 'ja' },
      ],
    });
    expect(titles(instance)).toEqual(['main']);
  });

  it('creates the duplicate title before the title case, so a renamed page cannot hide it', async () => {
    const { setting, instance } = await prepared({ honourTitle: true });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      faelle: {
        doppelterTitel: { status: 400, angelegt: 'nein' },
        titelImBody: { titelGeaendert: 'ja' },
      },
    });
  });

  it('says «unbekannt» when a page cannot be read back, instead of «nein»', async () => {
    const { setting, instance } = await prepared();
    let patches = 0;
    const flaky = rewriting(instance, ({ method, url }) => {
      if (method === 'PATCH') {
        patches += 1;
      }
      if (
        method === 'GET' &&
        patches === 7 &&
        /\/pages\/[^/]+$/.test(url.pathname)
      ) {
        patches += 100;
        return refused(500);
      }
      if (method === 'GET' && url.pathname.endsWith('/versions')) {
        // Refused, although the body carries a list: only the status counts.
        return new Response(
          JSON.stringify({ data: [{ version: 1 }, { version: 2 }] }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }
      return undefined;
    });
    const run = await runOne(write, flaky, setting.env, confirming(instance));
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toMatchObject({
      seiten: { markdown1: { anzahlVersionen: 'unbekannt' } },
      faelle: {
        ifMatch: {
          status: 200,
          versionGestiegen: 'unbekannt',
          textUebernommen: 'unbekannt',
          leseStatus: 500,
        },
        ifUnmodifiedSince: {
          versionGestiegen: 'unbekannt',
          textUebernommen: 'ja',
        },
      },
    });
  });

  it('keeps the names of the pages for the web editor when one create fails', async () => {
    const { setting, instance } = await prepared();
    let posts = 0;
    const firstRefused = rewriting(instance, ({ method }) => {
      if (method === 'POST') {
        posts += 1;
        return posts === 1 ? refused(400) : undefined;
      }
      return undefined;
    });
    const run = await runOne(
      write,
      firstRefused,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    const state = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    );
    expect(state.pages.map((page) => page.role)).toEqual([
      'markdown2',
      'standardformat',
      'faelle',
    ]);
    const after = await runOne(roundtrip, instance, setting.env);
    expect(after.code, after.output.stderr()).toBe(exitCodes.ok);
    expect(after.result).toMatchObject({
      seiten: {
        markdown1: { stand: 'fehlt' },
        markdown2: { isMarkdownGelesen: 'wahr' },
        standardformat: { isMarkdownGelesen: 'falsch' },
      },
    });
  });

  it('judges the cases by their marker line when the instance changes the text on create', async () => {
    const trimmed = (text: string): string =>
      text
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n');
    const { setting, instance } = await prepared({
      normalizeOnCreate: trimmed,
    });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      seiten: {
        markdown1: {
          textGleich: 'nein',
          aenderungen: [
            {
              zeile: corpus.findIndex((line) => line.endsWith('  ')) + 1,
              art: 'Leerzeichen am Zeilenende',
            },
          ],
        },
      },
      faelle: {
        gleicherText: { versionGestiegen: 'nein', textUebernommen: 'ja' },
        neuerText: { textUebernommen: 'ja' },
      },
    });
    const [first] = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    ).pages;
    instance.editorSave(first?.guid ?? '', (text) =>
      text.replace('* Stern', '- Stern'),
    );
    const after = await runOne(roundtrip, instance, setting.env);
    expect(after.result).toMatchObject({
      seiten: {
        markdown1: {
          standNach05: 'weicht ab',
          aenderungen: [
            {
              zeile: corpus.findIndex((line) => line.startsWith('* Stern')) + 1,
              art: 'Listenzeichen',
            },
            {
              zeile: corpus.findIndex((line) => line.endsWith('  ')) + 1,
              art: 'Leerzeichen am Zeilenende',
            },
          ],
        },
      },
    });
  });

  it('says «fehlt» for fields a read-back lacks, and records no state for 06 then', async () => {
    const { setting, instance } = await prepared();
    let pageReads = 0;
    const bare = rewriting(instance, async ({ method, url }) => {
      if (method !== 'GET' || !/\/pages\/[^/]+$/.test(url.pathname)) {
        return undefined;
      }
      pageReads += 1;
      if (pageReads !== 1) {
        return undefined;
      }
      const full = await instance.fetch(url, { method: 'GET' });
      const body = (await full.json()) as { data: Record<string, unknown> };
      const rest = without(body.data, 'guid', 'text');
      return new Response(JSON.stringify({ data: rest }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const run = await runOne(write, bare, setting.env, confirming(instance));
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      seiten: {
        markdown1: { identifierGleichGuid: 'fehlt', textGleich: 'fehlt' },
      },
    });
    const after = await runOne(roundtrip, instance, setting.env);
    expect(after.result).toMatchObject({
      seiten: { markdown1: { stand: 'fehlt' } },
    });
  });

  it('takes a case by its marker line even if the instance changes line breaks and spaces', async () => {
    const { setting, instance } = await prepared({
      normalizeOnUpdate: (text) => `${text.replaceAll('\n', '\r\n')}  \r\n`,
    });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      faelle: {
        neuerText: { textUebernommen: 'ja' },
        ifMatch: { textUebernommen: 'ja' },
      },
    });
  });

  it('stops after a create that names no GUID, and 07 still finds the page by its title', async () => {
    const { setting, instance } = await prepared();
    let posts = 0;
    const nameless: WriteInstance = {
      ...instance,
      fetch: async (url, init) => {
        const response = await instance.fetch(url, init);
        if (init.method !== 'POST' || ++posts !== 2) {
          return response;
        }
        // The instance creates the page but answers without its GUID.
        await response.body?.cancel();
        return new Response(JSON.stringify({ data: {} }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const run = await runOne(
      write,
      nameless,
      setting.env,
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.network);
    expect(run.output.stderr()).toContain(hints.schreibenAbgebrochen);
    expect(
      writes(instance).filter((call) => call.startsWith('POST')),
    ).toHaveLength(2);
    expect(titles(instance)).toHaveLength(3);

    const removed = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(removed.code, removed.output.stderr()).toBe(exitCodes.ok);
    expect(removed.result).toMatchObject({
      seiten: [
        { ergebnis: 'gelöscht' },
        { ergebnis: 'gelöscht', gefundenUeber: 'Titel' },
      ],
    });
    expect(titles(instance)).toEqual(['main']);
  });

  it('refuses to run on the leftovers of an earlier run', async () => {
    const { setting, instance } = await prepared();
    expect(
      (await runOne(write, instance, setting.env, confirming(instance))).code,
    ).toBe(exitCodes.ok);
    instance.calls.length = 0;
    const again = await runOne(
      write,
      instance,
      {
        ...setting.env,
        ECCLIUM_SPIKE_WRITE_STATE_FILE: join(
          setting.folder,
          'zweiter-lauf.jsonl',
        ),
      },
      confirming(instance),
    );
    expect(again.code).toBe(exitCodes.configuration);
    expect(again.output.stderr()).toContain(hints.fremdeSeiten);
    expect(writes(instance)).toEqual([]);
  });

  it('stops before any request if its write state file exists or a read-back operation is missing', async () => {
    const { setting, instance } = await prepared();
    writeFileSync(setting.writeStateFile, '', { mode: 0o600 });
    const existing = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(existing.code).toBe(exitCodes.configuration);
    expect(existing.output.stderr()).toContain(hints.schreibStateVorhanden);
    expect(instance.calls).toEqual([]);

    const document = {
      ...specification,
      paths: Object.fromEntries(
        Object.entries(specification.paths).filter(
          ([path]) => !path.endsWith('/versions'),
        ),
      ),
    };
    const other = await prepared({ document });
    const missing = await runOne(
      write,
      other.instance,
      other.setting.env,
      confirming(other.instance),
    );
    expect(missing.code).toBe(exitCodes.configuration);
    expect(missing.output.stderr()).toContain(hints.leseOperationFehlt);
    expect(other.instance.calls).toEqual([]);
  });
});

describe('06-wiki-editor-roundtrip', () => {
  const lineOf = (start: string): number =>
    corpus.findIndex((line) => line.startsWith(start)) + 1;

  async function written(): Promise<{
    setting: WriteSetting;
    instance: WriteInstance;
    guids: string[];
  }> {
    const ready = await prepared();
    const run = await runOne(
      write,
      ready.instance,
      ready.setting.env,
      confirming(ready.instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    ready.instance.calls.length = 0;
    const guids = readWriteState(
      ready.setting.writeStateFile,
      writeOrigin,
      ready.setting.writeCategory,
    )
      .pages.filter((page) => page.role !== 'faelle')
      .map((page) => page.guid);
    return { ...ready, guids };
  }

  it('names what the web editor changed, by kind and line, and writes nothing', async () => {
    const { setting, instance, guids } = await written();
    const [first, second, third] = guids;
    instance.editorSave(first ?? '', (text) =>
      text
        .replace('* Stern', '- Stern')
        .split('\n')
        .filter((line) => !line.startsWith('<!--'))
        .join('\n'),
    );
    instance.editorSave(second ?? '', (text) => text);
    instance.editorSave(third ?? '', (text) =>
      text.replace(
        'https://example.org/',
        '[https://example.org/](https://example.org/)',
      ),
    );
    const run = await runOne(roundtrip, instance, setting.env);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(writes(instance)).toEqual([]);
    expect(run.result).toEqual({
      probe: '06-wiki-editor-roundtrip',
      seiten: {
        markdown1: {
          versionGestiegen: 'ja',
          textGeaendert: 'ja',
          isMarkdownGelesen: 'wahr',
          anzahlVersionen: '2–9',
          standNach05: 'Korpus',
          htmlKommentarErhalten: 'nein',
          aenderungen: [
            { zeile: lineOf('* Stern'), art: 'Listenzeichen' },
            { zeile: lineOf('<!--'), art: 'HTML-Kommentar entfernt' },
          ],
        },
        markdown2: {
          versionGestiegen: 'ja',
          textGeaendert: 'nein',
          isMarkdownGelesen: 'wahr',
          anzahlVersionen: '2–9',
          standNach05: 'Korpus',
          htmlKommentarErhalten: 'ja',
          aenderungen: [],
        },
        standardformat: {
          versionGestiegen: 'ja',
          textGeaendert: 'ja',
          isMarkdownGelesen: 'falsch',
          anzahlVersionen: '2–9',
          standNach05: 'Korpus',
          htmlKommentarErhalten: 'ja',
          aenderungen: [
            {
              zeile: lineOf('Eine nackte Adresse'),
              art: 'URL in Link umgewandelt',
            },
          ],
        },
      },
    });
  });

  it('prints at most thirty changes and the class of the others', async () => {
    const { setting, instance, guids } = await written();
    const [first] = guids;
    instance.editorSave(
      first ?? '',
      (text) =>
        `${text}\n${Array.from({ length: 45 }, (_, n) => `Neue Zeile ${String(n)}`).join('\n')}`,
    );
    const run = await runOne(roundtrip, instance, setting.env);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    const page = (
      run.result as {
        seiten: Record<
          string,
          { aenderungen: unknown[]; weitereAenderungen?: string }
        >;
      }
    ).seiten['markdown1'];
    expect(page?.aenderungen).toHaveLength(30);
    expect(page?.weitereAenderungen).toBe('10–99');
  });

  it('says «unbekannt» when the version list is refused or the text is missing', async () => {
    const { setting, instance } = await written();
    const partial = rewriting(instance, async ({ method, url }) => {
      if (method !== 'GET') {
        return undefined;
      }
      if (url.pathname.endsWith('/versions')) {
        return refused(403);
      }
      if (/\/pages\/[^/]+$/.test(url.pathname)) {
        const full = await instance.fetch(url, { method: 'GET' });
        const body = (await full.json()) as { data: Record<string, unknown> };
        const rest = without(body.data, 'text');
        return new Response(JSON.stringify({ data: rest }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return undefined;
    });
    const run = await runOne(roundtrip, partial, setting.env);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      seiten: {
        markdown1: { anzahlVersionen: 'unbekannt', textGeaendert: 'unbekannt' },
      },
    });
  });

  it('reports a page the editor never saved as unchanged', async () => {
    const { setting, instance } = await written();
    const run = await runOne(roundtrip, instance, setting.env);
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      seiten: {
        markdown1: { versionGestiegen: 'nein', textGeaendert: 'nein' },
      },
    });
  });

  it('stops before any request without a write state, and reads nothing beside a foreign page', async () => {
    const { setting, instance } = await prepared();
    const missing = await runOne(roundtrip, instance, setting.env);
    expect(missing.code).toBe(exitCodes.configuration);
    expect(missing.output.stderr()).toContain(hints.schreibStateNichtGefunden);
    expect(instance.calls).toEqual([]);

    const done = await written();
    const foreign = writeInstance(done.setting, {
      extraPages: [
        {
          guid: '0f8fad5b-d9cb-469f-a165-70867728950e',
          title: 'Fremde Seite',
          onStartpage: false,
          versions: [
            { version: 1, text: 'x', isMarkdown: true, modifiedDate: 'x' },
          ],
        },
      ],
    });
    const refused = await runOne(roundtrip, foreign, done.setting.env);
    expect(refused.code).toBe(exitCodes.configuration);
    expect(refused.output.stderr()).toContain(hints.fremdeSeiten);
    expect(foreign.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(foreign.calls).toHaveLength(3);
  });
});

describe('07-wiki-cleanup', () => {
  async function written(): Promise<{
    setting: WriteSetting;
    instance: WriteInstance;
  }> {
    const ready = await prepared();
    const run = await runOne(
      write,
      ready.instance,
      ready.setting.env,
      confirming(ready.instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    ready.instance.calls.length = 0;
    return ready;
  }

  it('deletes exactly the pages of the run, leaves «main», and can run again', async () => {
    const { setting, instance } = await written();
    const run = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(leaks(run.output, setting.forbidden)).toEqual([]);
    expect(run.result).toEqual({
      probe: '07-wiki-cleanup',
      anzahl: '2–9',
      seiten: Array.from({ length: 4 }, () => ({
        ergebnis: 'gelöscht',
        status: 204,
        danachNichtGefunden: 'ja',
      })),
    });
    expect(writes(instance)).toHaveLength(4);
    expect(writes(instance).every((call) => call.startsWith('DELETE '))).toBe(
      true,
    );
    expect(titles(instance)).toEqual(['main']);

    instance.calls.length = 0;
    const again = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(again.code).toBe(exitCodes.ok);
    expect(again.result).toMatchObject({
      seiten: Array.from({ length: 4 }, () => ({
        ergebnis: 'schon gelöscht',
      })),
    });
    expect(writes(instance)).toEqual([]);
  });

  it('skips a page whose title no longer carries the tag of the run', async () => {
    const { setting, instance } = await written();
    const [first] = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    ).pages;
    const page = instance.pages.get(first?.guid ?? '');
    if (page === undefined) {
      throw new Error('page missing');
    }
    instance.pages.set(page.guid, { ...page, title: 'Fremder Titel' });
    const run = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect((run.result as { seiten: unknown[] }).seiten[0]).toEqual({
      ergebnis: 'übersprungen',
      status: 200,
    });
    expect(instance.pages.has(page.guid)).toBe(true);
    expect(writes(instance)).toHaveLength(3);
  });

  it.each<[string, (data: Record<string, unknown>) => Record<string, unknown>]>(
    [
      ['in another category', (data) => ({ ...data, wikiCategory: { id: 1 } })],
      [
        'that may not be deleted',
        (data) => ({
          ...data,
          permissions: { canEdit: true, canDelete: false },
        }),
      ],
      [
        'under another GUID',
        (data) => ({ ...data, guid: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
      ],
    ],
  )('skips a page that reads back %s', async (_, change) => {
    const { setting, instance } = await written();
    const [first] = readWriteState(
      setting.writeStateFile,
      writeOrigin,
      setting.writeCategory,
    ).pages;
    const target = first?.guid ?? '';
    const rewriting: WriteInstance = {
      ...instance,
      fetch: async (url, init) => {
        const response = await instance.fetch(url, init);
        if (
          init.method !== 'GET' ||
          !url.pathname.endsWith(`/pages/${target}`)
        ) {
          return response;
        }
        const body = (await response.json()) as {
          data: Record<string, unknown>;
        };
        return new Response(JSON.stringify({ data: change(body.data) }), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const run = await runOne(
      cleanup,
      rewriting,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect((run.result as { seiten: unknown[] }).seiten[0]).toEqual({
      ergebnis: 'übersprungen',
      status: 200,
    });
    expect(instance.pages.has(target)).toBe(true);
  });

  it('deletes nothing if the write area holds a foreign page, or without a terminal', async () => {
    const { setting, instance } = await written();
    const foreign = writeInstance(setting, {
      extraPages: [
        {
          guid: '0f8fad5b-d9cb-469f-a165-70867728950e',
          title: 'Fremde Seite',
          onStartpage: false,
          versions: [
            { version: 1, text: 'x', isMarkdown: true, modifiedDate: 'x' },
          ],
        },
      ],
    });
    const refused = await runOne(
      cleanup,
      foreign,
      setting.env,
      confirming(foreign),
    );
    expect(refused.code).toBe(exitCodes.configuration);
    expect(refused.output.stderr()).toContain(hints.fremdeSeiten);
    expect(writes(foreign)).toEqual([]);

    const silent = await runOne(cleanup, instance, setting.env);
    expect(silent.code).toBe(exitCodes.configuration);
    expect(silent.output.stderr()).toContain(hints.keinTerminal);
    expect(instance.calls).toEqual([]);
  });

  it('finds a page whose create answer was lost by the title of the run, and removes it', async () => {
    // Three reads of the guard, the first create, then the second create,
    // which the instance carries out but whose answer is lost.
    const { setting, instance } = await prepared({ loseAnswerOnCall: 5 });
    const run = await runOne(
      write,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.network);
    expect(run.output.stderr()).toContain(hints.schreibenAbgebrochen);
    expect(
      readWriteState(setting.writeStateFile, writeOrigin, setting.writeCategory)
        .pages,
    ).toHaveLength(1);
    expect(titles(instance)).toHaveLength(3);

    const removed = await runOne(
      cleanup,
      instance,
      setting.env,
      confirming(instance),
    );
    expect(removed.code, removed.output.stderr()).toBe(exitCodes.ok);
    expect(removed.result).toMatchObject({
      seiten: [
        { ergebnis: 'gelöscht' },
        { ergebnis: 'gelöscht', gefundenUeber: 'Titel' },
      ],
    });
    expect(titles(instance)).toEqual(['main']);
  });

  it('says «fehlgeschlagen» for a refused deletion', async () => {
    const ready = await prepared({ deleteStatus: 403 });
    expect(
      (
        await runOne(
          write,
          ready.instance,
          ready.setting.env,
          confirming(ready.instance),
        )
      ).code,
    ).toBe(exitCodes.ok);
    const run = await runOne(
      cleanup,
      ready.instance,
      ready.setting.env,
      confirming(ready.instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect((run.result as { seiten: unknown[] }).seiten[0]).toEqual({
      ergebnis: 'fehlgeschlagen',
      status: 403,
      danachNichtGefunden: 'nein',
    });
  });

  it('says «noch vorhanden» when the page stays, and «unbekannt» when it cannot tell', async () => {
    const kept = await prepared({ deleteKeepsPage: true });
    expect(
      (
        await runOne(
          write,
          kept.instance,
          kept.setting.env,
          confirming(kept.instance),
        )
      ).code,
    ).toBe(exitCodes.ok);
    const stays = await runOne(
      cleanup,
      kept.instance,
      kept.setting.env,
      confirming(kept.instance),
    );
    expect((stays.result as { seiten: unknown[] }).seiten[0]).toEqual({
      ergebnis: 'noch vorhanden',
      status: 204,
      danachNichtGefunden: 'nein',
    });

    const { setting, instance } = await written();
    let deleted = false;
    const unclear = rewriting(instance, ({ method, url }) => {
      if (method === 'DELETE') {
        deleted = true;
        return undefined;
      }
      return deleted && method === 'GET' && /\/pages\/[^/]+$/.test(url.pathname)
        ? refused(500)
        : undefined;
    });
    const run = await runOne(
      cleanup,
      unclear,
      setting.env,
      confirming(instance),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect((run.result as { seiten: unknown[] }).seiten[0]).toEqual({
      ergebnis: 'unbekannt',
      status: 204,
      danachNichtGefunden: 'unbekannt',
    });
  });

  it('does not claim a write after an error before its first deletion', async () => {
    const { setting, instance } = await written();
    const timeouts = rewriting(instance, ({ method, url }) =>
      method === 'GET' && /\/pages\/[^/]+$/.test(url.pathname)
        ? Promise.reject(
            new DOMException('The operation timed out.', 'TimeoutError'),
          )
        : undefined,
    );
    const run = await runOne(
      cleanup,
      timeouts,
      setting.env,
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.network);
    expect(run.output.stderr()).not.toContain(hints.schreibenAbgebrochen);
    expect(writes(instance)).toEqual([]);
  });

  it('stops before any request with a write state of another write area', async () => {
    const { setting, instance } = await written();
    const run = await runOne(
      cleanup,
      instance,
      {
        ...setting.env,
        ECCLIUM_SPIKE_WRITE_CATEGORY_ID: String(setting.writeCategory + 1),
      },
      confirming(instance),
    );
    expect(run.code).toBe(exitCodes.configuration);
    expect(run.output.stderr()).toContain(hints.schreibStateUngueltig);
    expect(instance.calls).toEqual([]);
  });
});
