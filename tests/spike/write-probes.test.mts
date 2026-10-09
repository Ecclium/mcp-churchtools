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
import { probe as cleanup } from '../../scripts/spike/07-wiki-cleanup.mts';
import { corpusText, textHash } from '../../scripts/spike/lib/corpus.mts';
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
}

async function runOne(
  definition: ProbeDefinition,
  instance: WriteInstance,
  env: Readonly<Record<string, string | undefined>>,
  input?: Input,
): Promise<Run> {
  const output = capture();
  const code = await runProbe(definition, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    ...(input === undefined ? {} : { input }),
  });
  const text = output.stdout();
  return { code, output, result: text === '' ? undefined : JSON.parse(text) };
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

const writes = (instance: WriteInstance): string[] =>
  instance.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => `${call.method} ${call.url.pathname}`);

const titles = (instance: WriteInstance): string[] =>
  [...instance.pages.values()].map((page) => page.title);

describe('05-wiki-write', () => {
  it('writes four pages and the cases, and prints only fixed words', async () => {
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
      'editor',
      'editor',
      'editor',
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
      ...Array.from({ length: 9 }, () => `PATCH ${area}/${cases?.guid ?? ''}`),
      `POST ${area}`,
    ]);
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
