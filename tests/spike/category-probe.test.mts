// Runs probe 12 against a synthetic instance full of canary values (see
// tests/fixtures/README.md), in the three ways an instance could treat a
// page under the path of another category: refuse it, serve the page with
// its own category, or serve it with the category of the path. The probe
// must write only after «ja», create exactly one page in the write area,
// change only that page, record it at once and print no value of the
// instance.
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probe as inventory } from '../../scripts/spike/00-inventory.mts';
import { probe as cleanup } from '../../scripts/spike/07-wiki-cleanup.mts';
import {
  namedCategory,
  probe as categoryProbe,
} from '../../scripts/spike/12-wiki-category.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { Input } from '../../scripts/spike/lib/gate.mts';
import type { ProbeResponse } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import { readWriteState } from '../../scripts/spike/lib/write-state.mts';
import { capture, leaks, type Capture } from './support.mts';
import {
  makeGuid,
  writeInstance,
  writeOrigin,
  writeSetup,
  type WriteInstance,
  type WriteSetting,
} from './write-support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

/** How the synthetic instance treats a page under a foreign path. */
type Mode = 'refuse' | 'real' | 'path';

/** A request as the probe sent it, before any forwarding. */
interface Sent {
  readonly method: string;
  readonly path: string;
}

/**
 * The instance of the write tests with a page in the identification
 * category and the given treatment of a foreign path. A request for the
 * own page under the path of the identification category goes on to the
 * write area, as an instance that ignores the category of the path would
 * do.
 */
function crossing(
  instance: WriteInstance,
  setting: WriteSetting,
  mode: Mode,
  options: { readonly kennPages?: boolean; readonly failPatch?: boolean } = {},
): { instance: WriteInstance; sent: Sent[] } {
  const sent: Sent[] = [];
  const area = setting.writeCategory;
  const identification = setting.identification;
  const kennGuid = makeGuid();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const kennData = (category: number) => ({
    guid: kennGuid,
    title: setting.canaries.groupName,
    version: 1,
    isMarkdown: true,
    text: setting.canaries.personName,
    wikiCategory: { id: category, name: setting.canaries.groupName },
  });
  const listPath = `/api/wiki/categories/${String(identification)}/pages`;
  const foreignPrefix = `${listPath}/`;
  const kennUnderArea = `/api/wiki/categories/${String(area)}/pages/${kennGuid}`;
  return {
    sent,
    instance: {
      ...instance,
      fetch: async (url, init) => {
        const method = init.method ?? 'GET';
        sent.push({ method, path: url.pathname });
        if (url.pathname === listPath && method === 'GET') {
          instance.calls.push({
            method,
            url,
            headers: new Headers(init.headers),
            body: undefined,
          });
          return json({
            data: options.kennPages === false ? [] : [kennData(identification)],
            meta: { count: options.kennPages === false ? 0 : 1 },
          });
        }
        if (url.pathname === kennUnderArea) {
          return mode === 'refuse'
            ? json({ message: setting.canaries.personName }, 404)
            : json({
                data: kennData(mode === 'real' ? identification : area),
              });
        }
        if (url.pathname.startsWith(foreignPrefix)) {
          if (method === 'PATCH' && options.failPatch === true) {
            throw new TypeError('fetch failed', {
              cause: { code: 'ECONNRESET' },
            });
          }
          if (mode === 'refuse') {
            return json(
              { message: setting.canaries.personName },
              method === 'GET' ? 404 : 403,
            );
          }
          const forwarded = new URL(
            url.pathname.replace(
              foreignPrefix,
              `/api/wiki/categories/${String(area)}/pages/`,
            ),
            url,
          );
          const answer = await instance.fetch(forwarded, init);
          if (mode === 'real') return answer;
          const body = (await answer.json()) as { data: object };
          return json(
            {
              data: {
                ...body.data,
                wikiCategory: { id: identification },
              },
            },
            answer.status,
          );
        }
        return instance.fetch(url, init);
      },
    },
  };
}

/** A terminal that answers with the given text and counts the calls before. */
function terminal(
  sent: readonly Sent[],
  answer = 'ja',
): Input & { before: number[] } {
  const before: number[] = [];
  return {
    before,
    isTerminal: true,
    readLine: () => {
      before.push(sent.length);
      return Promise.resolve(answer);
    },
  };
}

async function runOne(
  definition: ProbeDefinition,
  instance: WriteInstance,
  env: Readonly<Record<string, string | undefined>>,
  input?: Input,
): Promise<{ code: number; output: Capture; result: unknown }> {
  const output = capture();
  const code = await runProbe(definition, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    wait: () => Promise.resolve(),
    ...(input === undefined ? {} : { input }),
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
  };
}

async function prepared(): Promise<{
  setting: WriteSetting;
  instance: WriteInstance;
}> {
  const setting = writeSetup();
  const instance = writeInstance(setting);
  const run = await runOne(inventory, instance, setting.inventoryEnv);
  expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
  instance.calls.length = 0;
  return { setting, instance };
}

// The writes the probe sent, with the IDs of the categories named.
const writesOf = (sent: readonly Sent[], setting: WriteSetting): string[] =>
  sent
    .filter((call) => call.method !== 'GET')
    .map((call) =>
      `${call.method} ${call.path}`
        .replace(`/categories/${String(setting.writeCategory)}/`, '/W/')
        .replace(`/categories/${String(setting.identification)}/`, '/K/')
        .replace(/\/[0-9a-f-]{36}$/, '/{guid}'),
    );

describe('12-wiki-category', () => {
  it.each<[Mode, Record<string, unknown>]>([
    [
      'refuse',
      {
        eigeneSeiteUnterKennkategorie: { status: 404 },
        kennseiteUnterSchreibbereich: { status: 404 },
        aendernUnterKennkategorie: {
          status: 403,
          versionGestiegen: 'nein',
          textGeaendert: 'nein',
        },
      },
    ],
    [
      'real',
      {
        eigeneSeiteUnterKennkategorie: { status: 200, kategorie: 'Seite' },
        kennseiteUnterSchreibbereich: { status: 200, kategorie: 'Seite' },
        aendernUnterKennkategorie: {
          status: 200,
          kategorie: 'Seite',
          versionGestiegen: 'ja',
          textGeaendert: 'ja',
        },
      },
    ],
    [
      'path',
      {
        eigeneSeiteUnterKennkategorie: { status: 200, kategorie: 'Pfad' },
        kennseiteUnterSchreibbereich: { status: 200, kategorie: 'Pfad' },
        aendernUnterKennkategorie: {
          status: 200,
          kategorie: 'Pfad',
          versionGestiegen: 'ja',
          textGeaendert: 'ja',
        },
      },
    ],
  ])(
    'tells how an instance that does %s treats a foreign path, and prints no value',
    async (mode, expected) => {
      const ready = await prepared();
      const { instance, sent } = crossing(ready.instance, ready.setting, mode);
      const input = terminal(sent);
      const run = await runOne(
        categoryProbe,
        instance,
        ready.setting.env,
        input,
      );
      expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
      expect(leaks(run.output, ready.setting.forbidden)).toEqual([]);
      expect(run.result).toEqual({
        probe: '12-wiki-category',
        anlegen: { status: 201 },
        ...expected,
      });
      // Nothing is written before the person confirms, and afterwards only
      // the own page: once created in the write area, once changed under
      // the path of the identification category.
      expect(input.before).toHaveLength(1);
      expect(
        sent.slice(0, input.before[0]).every((call) => call.method === 'GET'),
      ).toBe(true);
      expect(writesOf(sent, ready.setting)).toEqual([
        'POST /api/wiki/W/pages',
        'PATCH /api/wiki/K/pages/{guid}',
      ]);
      const state = readWriteState(
        ready.setting.writeStateFile,
        writeOrigin,
        ready.setting.writeCategory,
      );
      expect(state.pages.map((page) => page.role)).toEqual(['kategorie']);
      const [page] = state.pages;
      expect(
        sent
          .find((call) => call.method === 'PATCH')
          ?.path.endsWith(page?.guid ?? '-'),
      ).toBe(true);
    },
  );

  it('says so when the identification category lists no page', async () => {
    const ready = await prepared();
    const { instance, sent } = crossing(ready.instance, ready.setting, 'real', {
      kennPages: false,
    });
    const run = await runOne(
      categoryProbe,
      instance,
      ready.setting.env,
      terminal(sent),
    );
    expect(run.code, run.output.stderr()).toBe(exitCodes.ok);
    expect(run.result).toMatchObject({
      kennseiteUnterSchreibbereich: 'keine Seite in der Kennkategorie',
    });
  });

  it('writes nothing without «ja»', async () => {
    const ready = await prepared();
    const { instance, sent } = crossing(ready.instance, ready.setting, 'real');
    const run = await runOne(
      categoryProbe,
      instance,
      ready.setting.env,
      terminal(sent, 'nein'),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(writesOf(sent, ready.setting)).toEqual([]);
  });

  it('stops after a failed change with the hint to clean up, and 07 removes the page', async () => {
    const ready = await prepared();
    const { instance, sent } = crossing(ready.instance, ready.setting, 'real', {
      failPatch: true,
    });
    const run = await runOne(
      categoryProbe,
      instance,
      ready.setting.env,
      terminal(sent),
    );
    expect(run.code).not.toBe(exitCodes.ok);
    expect(run.output.stderr()).toContain(hints.schreibenAbgebrochen);
    expect(leaks(run.output, ready.setting.forbidden)).toEqual([]);
    expect(writesOf(sent, ready.setting)).toEqual([
      'POST /api/wiki/W/pages',
      'PATCH /api/wiki/K/pages/{guid}',
    ]);

    ready.instance.calls.length = 0;
    const cleaned = await runOne(
      cleanup,
      ready.instance,
      ready.setting.env,
      terminal(sent),
    );
    expect(cleaned.code, cleaned.output.stderr()).toBe(exitCodes.ok);
    expect(
      [...ready.instance.pages.values()].map((page) => page.title),
    ).toEqual(['main']);
  });
});

describe('namedCategory', () => {
  const response = (body: unknown): ProbeResponse => ({
    status: 200,
    headers: new Headers(),
    setCookies: [],
    kind: 'JSON',
    body,
  });

  it.each([
    [{ data: { wikiCategory: { id: 12 } } }, 'Pfad'],
    [{ data: { wikiCategory: { id: 9 } } }, 'Seite'],
    [{ data: { wikiCategory: { id: 3 } } }, 'andere'],
    [{ data: { wikiCategory: { id: '12' } } }, 'fehlt'],
    [{ data: { wikiCategory: null } }, 'fehlt'],
    [{ data: [] }, 'fehlt'],
  ])('reads %j as %s', (body, word) => {
    expect(namedCategory(response(body), 12, 9)).toBe(word);
  });
});
