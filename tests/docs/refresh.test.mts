// The whole run of pnpm docs:refresh against a synthetic instance and a
// synthetic Academy, through the frame of the probes: it reads the state
// file, asks the instance for the rights and the Academy for its help
// pages, writes the five files and prints only counts (ADR 0066). The
// files it writes must pass the checks of the package, hold no value of
// the instance and no raw source, and nothing of the sources may reach
// its output.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  looksLikeHtmlPage,
  looksLikeOpenApiDocument,
  parseFactFiles,
} from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import {
  categoriesDefinition,
  checkInstanceHost,
  refreshDefinition,
} from '../../scripts/docs/refresh.mts';
import { academyOrigin } from '../../scripts/spike/lib/academy.mts';
import {
  createState,
  instanceId,
  type Environment,
} from '../../scripts/spike/lib/env.mts';
import { hints } from '../../scripts/spike/lib/errors.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import type { OpenApiDocument } from '../../scripts/spike/lib/spec.mts';
import {
  capture,
  forbiddenTexts,
  leaks,
  makeCanaries,
  privateFiles,
  type Canaries,
} from '../spike/support.mts';

const hosted = (label: string): string => [label, 'church', 'tools'].join('.');
const docsFolder = fileURLToPath(
  new URL('../../scripts/docs/', import.meta.url),
);
// The instance of this test, so that the placeholder in the facts and its
// host can be told apart.
const origin = `https://${hosted('demo-tenant')}`;
const files = [
  'SOURCES.json',
  'academy.json',
  'operation-rights.json',
  'operations.json',
  'rights.json',
];

function syntheticDocument(licence = 'CC BY 4.0'): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Synthetic API',
      version: '0.1.0',
      license: { name: licence },
      contact: { name: 'Synthetic Forum', email: 'someone@example.com' },
    },
    servers: [{ url: `https://${hosted('demo-tenant')}/api` }],
    paths: {
      '/api/permissions/global': {
        get: {
          operationId: 'getGlobalPermissions',
          summary: 'Rights of the account',
          responses: { '200': { description: 'The rights.' } },
        },
      },
      '/api/synthetic/things': {
        get: {
          operationId: 'listSyntheticThings',
          description: `Lists things, see https://${hosted('demo-tenant')}/things`,
          responses: { '200': { description: 'The things.' } },
        },
      },
    },
  };
}

// The instance answers only the rights, with a canary in a list; the
// Academy answers robots.txt, both taxonomies and two help pages, one of
// another section, with fields the refresh never asks for.
function syntheticFetch(
  canaries: Canaries,
  info: { version: string } = { version: '3.138.2' },
): {
  fetch: FetchFunction;
  calls: { url: URL; agent: string | null; authorization: string | null }[];
} {
  const calls: {
    url: URL;
    agent: string | null;
    authorization: string | null;
  }[] = [];
  const fetch: FetchFunction = (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: input,
      agent: headers.get('user-agent'),
      authorization: headers.get('authorization'),
    });
    if (
      input.origin === origin &&
      input.pathname === '/api/permissions/global'
    ) {
      return Promise.resolve(
        Response.json({
          data: {
            churchwiki: { view: true, 'view category': [canaries.number] },
            churchcore: {
              'administer persons': false,
              [canaries.groupName]: true,
            },
          },
        }),
      );
    }
    if (input.origin === origin && input.pathname === '/api/info') {
      return Promise.resolve(Response.json({ version: info.version }));
    }
    if (input.origin !== academyOrigin) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    const list = (body: unknown) =>
      Response.json(body, { headers: { 'x-wp-totalpages': '1' } });
    switch (input.pathname) {
      case '/robots.txt':
        return Promise.resolve(
          new Response('User-agent: *\nDisallow: /wp-admin/\n', {
            headers: { 'content-type': 'text/plain' },
          }),
        );
      case '/de/wp-json/wp/v2/doc_category':
        return Promise.resolve(
          list([
            { id: 1, slug: 'gruppen', parent: 0 },
            { id: 2, slug: 'website', parent: 0 },
          ]),
        );
      case '/de/wp-json/wp/v2/knowledge_base':
        return Promise.resolve(
          list([{ id: 10, slug: 'churchtools-module', parent: 0 }]),
        );
      case '/de/wp-json/wp/v2/docs':
        return Promise.resolve(
          list([
            {
              id: 1,
              slug: 'mitglieder',
              link: `${academyOrigin}/de/help/gruppen/mitglieder/`,
              status: 'publish',
              modified_gmt: '2026-10-01T12:00:00',
              title: { rendered: 'Mitglieder sehen' },
              content: {
                rendered: `<h2>Rechte</h2><p>Gruppen&shy;mitglieder sehen, etwa auf <a href="https://${hosted('demo-tenant')}/">Ihrer Instanz</a> oder <a href="/de/help/gruppen/">in Gruppen</a>.</p><img src="a.png">`,
                protected: false,
              },
              doc_category: [1],
              knowledge_base: [10],
              author: canaries.personName,
            },
            {
              id: 2,
              slug: 'website',
              link: `${academyOrigin}/de/help/website/start/`,
              status: 'publish',
              modified_gmt: '2026-10-01T12:00:00',
              title: { rendered: 'Website' },
              content: { rendered: '<p>Andere Seite</p>', protected: false },
              doc_category: [2],
              knowledge_base: [10],
            },
          ]),
        );
      default:
        return Promise.resolve(new Response('', { status: 404 }));
    }
  };
  return { fetch, calls };
}

async function run(
  definitionFor: (dataDir: URL) => ProbeDefinition,
  document: OpenApiDocument = syntheticDocument(),
  version = '3.138.2',
  prepare: (dataDir: string) => void = () => undefined,
) {
  const canaries = makeCanaries();
  const privates = privateFiles(canaries.token);
  createState(privates.stateFile, {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.138',
    specification: document,
  });
  const written = new Date('2026-10-29T07:15:30.500Z');
  utimesSync(privates.stateFile, written, written);
  const dataDir = mkdtempSync(join(tmpdir(), 'docs-refresh-'));
  const env: Environment = {
    ECCLIUM_SPIKE_BASE_URL: origin,
    ECCLIUM_SPIKE_TOKEN_FILE: privates.tokenFile,
    ECCLIUM_SPIKE_STATE_FILE: privates.stateFile,
  };
  prepare(dataDir);
  const instance = syntheticFetch(canaries, { version });
  const output = capture();
  const waits: number[] = [];
  const code = await runProbe(definitionFor(pathToFileURL(`${dataDir}/`)), {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: docsFolder,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  const texts = Object.fromEntries(
    readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [
        entry.name,
        readFileSync(join(dataDir, entry.name), 'utf8'),
      ]),
  );
  return {
    code,
    output,
    texts,
    calls: instance.calls,
    waits,
    canaries,
    forbidden: forbiddenTexts(canaries, privates.folder, 'demo-tenant'),
  };
}

const clock = () => new Date('2026-10-29T08:00:00Z');

describe('pnpm docs:refresh', () => {
  it('writes five files that pass the checks of the docs index', async () => {
    const result = await run((dataDir) => refreshDefinition(dataDir, clock));
    expect(result.code, result.output.stderr()).toBe(exitCodes.ok);
    expect(Object.keys(result.texts).sort()).toEqual(files);
    const facts = parseFactFiles({
      'SOURCES.json': result.texts['SOURCES.json'] ?? '',
      'operations.json': result.texts['operations.json'] ?? '',
      'rights.json': result.texts['rights.json'] ?? '',
      'academy.json': result.texts['academy.json'] ?? '',
      'operation-rights.json': result.texts['operation-rights.json'] ?? '',
    });
    expect(facts.operations.entries.map((entry) => entry.operationId)).toEqual([
      'getGlobalPermissions',
      'listSyntheticThings',
    ]);
    expect(
      facts.rights.entries.map((right) => `${right.module}: ${right.name}`),
    ).toEqual([
      'churchcore: administer persons',
      'churchwiki: view',
      'churchwiki: view category',
    ]);
    expect(facts.academy.entries).toEqual([
      {
        path: '/de/help/gruppen/mitglieder/',
        title: 'Mitglieder sehen',
        section: 'gruppen',
        knowledgeBase: 'churchtools-module',
        modified: '2026-10-01',
        text: '## Rechte\n\nGruppenmitglieder sehen, etwa auf Ihrer Instanz oder [in Gruppen](/de/help/gruppen/).',
      },
    ]);
    expect(facts.operations.notice).toContain('«Synthetic API»');
  });

  it('names its sources with time, hash and versions', async () => {
    const result = await run((dataDir) => refreshDefinition(dataDir, clock));
    const sources = JSON.parse(result.texts['SOURCES.json'] ?? '{}') as Record<
      string,
      unknown
    >;
    const rights = JSON.parse(result.texts['rights.json'] ?? '{}') as {
      entries: unknown;
    };
    const sha = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    expect(sources).toEqual({
      format: 'ecclium.docs.sources.v1',
      openapi: {
        retrievedAt: '2026-10-29T07:15:30Z',
        sha256: sha(JSON.stringify(syntheticDocument())),
        documentVersion: '0.1.0',
        churchToolsVersion: '3.138',
      },
      permissions: {
        retrievedAt: '2026-10-29T08:00:00Z',
        // Over what rights.json publishes, never over the values.
        sha256: sha(JSON.stringify(rights.entries)),
        churchToolsVersion: '3.138',
      },
      academy: {
        retrievedAt: '2026-10-29T08:00:00Z',
        pages: [
          {
            path: '/de/help/gruppen/mitglieder/',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
          },
        ],
      },
    });
  });

  it('keeps every value of the instance and every raw source out of files and output', async () => {
    const result = await run((dataDir) => refreshDefinition(dataDir, clock));
    expect(leaks(result.output, result.forbidden)).toEqual([]);
    const all = Object.values(result.texts).join('\n').toLowerCase();
    // The placeholder may stand in the facts, in place of a host.
    for (const secret of result.forbidden.filter(
      (text) => text !== 'example.church.tools',
    )) {
      expect(all).not.toContain(secret);
    }
    const rights = JSON.parse(result.texts['rights.json'] ?? '{}') as {
      entries: unknown;
    };
    expect(JSON.stringify(rights.entries)).not.toMatch(/\d/);
    for (const text of Object.values(result.texts)) {
      expect(looksLikeOpenApiDocument(text)).toBe(false);
      expect(looksLikeHtmlPage(text)).toBe(false);
    }
  });

  it('prints only counts and sizes', async () => {
    const result = await run((dataDir) => refreshDefinition(dataDir, clock));
    expect(JSON.parse(result.output.stdout())).toMatchObject({
      refresh: 'docs',
      churchtoolsVersion: '3.138',
      operationen: 2,
      rechte: { geschrieben: 3, ausgelassen: 1 },
      hilfeseiten: {
        geschrieben: 1,
        andereAbschnitte: 1,
        nichtOeffentlich: 0,
        ohneWissensbasis: 0,
        ohneText: 0,
      },
    });
  });

  it('asks the Academy with its own agent, without a token, and the instance only for the rights', async () => {
    const result = await run((dataDir) => refreshDefinition(dataDir, clock));
    const academy = result.calls.filter(
      (call) => call.url.origin === academyOrigin,
    );
    const instance = result.calls.filter((call) => call.url.origin === origin);
    expect(academy.every((call) => call.agent === 'ecclium-docs-refresh')).toBe(
      true,
    );
    expect(academy.every((call) => call.authorization === null)).toBe(true);
    expect(instance.map((call) => call.url.pathname)).toEqual([
      '/api/info',
      '/api/permissions/global',
    ]);
    expect(result.waits.length).toBe(academy.length - 1);
    expect(result.waits.every((wait) => wait >= 3000)).toBe(true);
  });

  it('writes nothing and names only the place when a source has a form it cannot take', async () => {
    const result = await run(
      (dataDir) => refreshDefinition(dataDir, clock),
      syntheticDocument('MIT'),
    );
    expect(result.code).toBe(exitCodes.network);
    expect(result.texts).toEqual({});
    expect(result.output.stderr()).toContain('Stelle: openapi.info.license');
    expect(result.output.stderr()).toContain(hints.quelleUngueltig);
    expect(result.output.stdout()).toBe('');
  });

  it('lists the categories by section with --kategorien and writes nothing', async () => {
    const result = await run(() => categoriesDefinition(clock));
    expect(result.code, result.output.stderr()).toBe(exitCodes.ok);
    expect(JSON.parse(result.output.stdout())).toEqual({
      refresh: 'kategorien',
      kategorien: { gruppen: [], website: [] },
    });
    expect(result.texts).toEqual({});
    expect(
      result.calls.some((call) => call.url.pathname.endsWith('/docs')),
    ).toBe(false);
  });

  it('writes nothing when the instance reports another version than the state', async () => {
    const result = await run(
      (dataDir) => refreshDefinition(dataDir, clock),
      syntheticDocument(),
      '3.139.0',
    );
    expect(result.code).toBe(exitCodes.configuration);
    expect(result.texts).toEqual({});
    expect(result.output.stderr()).toContain(hints.stateVeraltet);
  });

  it('writes nothing when a text names the instance it read from', async () => {
    const document = syntheticDocument();
    const paths = document['paths'] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const operation = paths['/api/synthetic/things']?.['get'];
    if (operation !== undefined) {
      operation['summary'] = 'Things of Demo-Tenant';
    }
    const result = await run(
      (dataDir) => refreshDefinition(dataDir, clock),
      document,
    );
    expect(result.code).toBe(exitCodes.network);
    expect(result.texts).toEqual({});
    expect(result.output.stderr()).toContain('Stelle: operations.json');
  });

  it('keeps the old files when a new one cannot be written', async () => {
    const result = await run(
      (dataDir) => refreshDefinition(dataDir, clock),
      syntheticDocument(),
      '3.138.2',
      (dataDir) => {
        writeFileSync(join(dataDir, 'academy.json'), 'alt\n');
        // A folder in place of the new file of academy.json makes that one
        // write fail after the others.
        mkdirSync(join(dataDir, '.academy.json.refresh'));
      },
    );
    expect(result.code).toBe(exitCodes.internal);
    expect(result.texts).toEqual({ 'academy.json': 'alt\n' });
  });
});

describe('checkInstanceHost', () => {
  const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  it('looks only at what came from the sources, not at the format and the notice', () => {
    const texts = {
      'academy.json': file({
        format: 'demo-tenant.docs.academy.v1',
        notice: 'Von demo-tenant aufbereitet.',
        entries: [{ text: 'Gruppen sehen' }],
      }),
    };
    expect(() => {
      checkInstanceHost(texts, origin);
    }).not.toThrow();
  });

  it('names the file that holds the host or the first label of the instance', () => {
    for (const text of [
      hosted('demo-tenant'),
      'Die Demo-Tenant sieht',
    ] as const) {
      expect(() => {
        checkInstanceHost(
          { 'academy.json': file({ format: 'x', entries: [{ text }] }) },
          origin,
        );
      }).toThrow(expect.objectContaining({ where: 'academy.json' }) as unknown);
    }
  });
});
