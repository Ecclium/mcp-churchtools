// Runs probe 10 against a synthetic instance and a synthetic OpenAPI
// document whose texts are full of canary values (see
// tests/fixtures/README.md). The probe must print counts, classes and
// fixed words only, and the names of prefixes only on the test instance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyHost,
  countHosts,
  definesRight,
  namesAny,
  namesToolRight,
  prefixOf,
  probe,
  sizeOf,
  toolRightName,
  toolRights,
  type HostCounts,
} from '../../scripts/spike/10-docs-sources.mts';
import {
  createState,
  instanceId,
  type Environment,
} from '../../scripts/spike/lib/env.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';
import { runProbe } from '../../scripts/spike/lib/probe.mts';
import type { OpenApiDocument } from '../../scripts/spike/lib/spec.mts';
import {
  capture,
  forbiddenTexts,
  leaks,
  makeCanaries,
  origin,
  privateFiles,
  specification,
  type Canaries,
  type Capture,
} from './support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

const toolsReference = fileURLToPath(
  new URL('../../docs/tools.md', import.meta.url),
);

// A host under church.tools other than the placeholder names a real
// church, so the tests put such hosts together at run time and none
// stands in the repository.
const hosted = (label: string): string => [label, 'church', 'tools'].join('.');

/** One request the synthetic instance received. */
interface Call {
  readonly url: URL;
  readonly authorization: string | null;
}

/** How the synthetic instance answers. */
interface Answers {
  /** Names of the wiki categories the account sees. */
  readonly categories?: readonly string[];
  /** Status of the definitions of the rights. Default: 200. */
  readonly definitionsStatus?: number;
}

/** One run of the probe. */
interface Run {
  readonly code: number;
  readonly output: Capture;
  readonly result: unknown;
  readonly calls: readonly Call[];
  readonly forbidden: readonly string[];
}

// A synthetic document: the operations of the shared document, plus texts
// full of canary values, hosts of every class, deprecated operations, a
// doubled and a missing operationId and an extension.
function syntheticDocument(canaries: Canaries): OpenApiDocument {
  const mail = canaries.personEmail;
  return {
    ...specification,
    info: {
      title: 'Synthetic test document',
      description: `Copyright ChurchTools Innovations GmbH. Provided as is, without warranty. ${canaries.personName}`,
      version: '3.138.2',
      license: {
        name: 'CC BY 4.0',
        url: 'https://creativecommons.org/licenses/by/4.0/',
      },
      contact: { name: canaries.personName, email: mail },
      'x-logo': { url: 'https://example.org/logo.png' },
    },
    servers: [{ url: `${origin}/api` }, { url: '/api' }],
    paths: {
      ...specification.paths,
      '/persons/{id}/lines': {
        get: {
          operationId: 'getLines',
          deprecated: true,
          summary: `Needs the right view alldata. Ask ${mail}.`,
          'x-permission': 'churchdb',
        },
      },
      '/wiki/rights': {
        get: {
          operationId: 'getLines',
          description: `Berechtigung nötig, siehe https://churchtools.academy/de/help/ oder https://${hosted('demo-tenant')}/`,
          parameters: [
            {
              name: 'x',
              in: 'query',
              example: `${origin}/api/wiki/rights`,
            },
          ],
        },
        post: { description: 'Zur Rechteverwaltung, nach rechts.' },
        delete: { deprecated: true, description: 'view' },
      },
    },
  };
}

function syntheticInstance(
  canaries: Canaries,
  answers: Answers,
): { fetch: FetchFunction; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFunction = (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url: input, authorization: headers.get('authorization') });
    if (input.origin === origin && input.pathname === '/api/wiki/categories') {
      const names = answers.categories ?? [identificationCategoryName];
      return Promise.resolve(
        Response.json(
          {
            data: names.map((name, index) => ({
              id: canaries.number + index,
              name,
              permissions: { canEdit: false, canDelete: false },
            })),
            permissions: { editMasterData: false },
          },
          { headers: { 'x-kanarie': canaries.headerValue } },
        ),
      );
    }
    if (
      input.origin === origin &&
      input.pathname === '/api/permissions/definitions'
    ) {
      const status = answers.definitionsStatus ?? 200;
      return Promise.resolve(
        Response.json(
          status === 200
            ? syntheticDefinitions(canaries)
            : { message: canaries.personName, translatedMessage: 'nein' },
          { status },
        ),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };
  return { fetch, calls };
}

// Definitions of rights in two shapes: modules as keys with rights as
// keys, and a list of objects with module and right as texts. The labels
// carry canary values, one right lists the wiki categories with their
// names, and `view songcategory` is missing on purpose.
function syntheticDefinitions(canaries: Canaries): unknown {
  return {
    data: {
      churchdb: {
        'view alldata': { label: canaries.personName, type: 'list' },
      },
      churchgroup: {
        'view groups of grouptype': { label: canaries.groupName },
        'security level group': { label: 'Sicherheitsstufe' },
      },
      churchwiki: {
        view: { label: 'Wiki sehen' },
        'view category': {
          options: [
            { id: canaries.number, name: identificationCategoryName },
            { id: canaries.number + 1, name: canaries.groupName },
          ],
        },
      },
    },
    modules: [
      { module: 'churchcal', auth: 'view category' },
      { module: 'churchresource', auth: 'view resource' },
      { module: 'churchservice', auth: 'view events' },
      { module: 'churchservice', auth: 'view agenda' },
      { module: 'churchservice', auth: 'view servicegroup' },
    ],
  };
}

async function run(
  answers: Answers = {},
  edit: (document: OpenApiDocument) => OpenApiDocument = (document) => document,
): Promise<Run> {
  const canaries = makeCanaries();
  const files = privateFiles(canaries.token);
  createState(files.stateFile, {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.138',
    specification: edit(syntheticDocument(canaries)),
  });
  const env: Environment = {
    ECCLIUM_SPIKE_BASE_URL: origin,
    ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
    ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
  };
  const instance = syntheticInstance(canaries, answers);
  const output = capture();
  const code = await runProbe(probe, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    wait: () => Promise.resolve(),
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
    calls: instance.calls,
    forbidden: forbiddenTexts(canaries, files.folder, 'demo-tenant'),
  };
}

describe('10-docs-sources, part OpenAPI', () => {
  it('describes the document with counts and classes, and none of its texts', async () => {
    const result = await run();
    expect(result.code, result.output.stdout()).toBe(exitCodes.ok);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
    expect(result.result).toMatchObject({
      probe: '10-docs-sources',
      churchtoolsVersion: '3.138',
      testinstanz: 'ja',
      openapi: {
        format: 'OpenAPI 3',
        openapiVersion: '3.0.3',
        info: {
          schluessel: [
            'title',
            'description',
            'version',
            'license',
            'contact',
            'x-logo',
          ],
          lizenz: {
            name: 'CC BY 4.0',
            kennung: 'fehlt',
            url: 'Creative Commons',
          },
          kontakt: {
            schluessel: ['name', 'email'],
            url: 'fehlt',
            email: 'platzhalter',
          },
          nutzungsbedingungen: 'fehlt',
          hinweise: {
            urheberrecht: 'ja',
            hersteller: 'ja',
            gewaehrleistung: 'ja',
            lizenz: 'nein',
          },
          version: { dokument: '3.138.2', vergleich: 'gleich' },
        },
        hosts: {
          servers: { texte: '2–9', hostDerInstanz: '1', platzhalter: '0' },
          beispiele: { hostDerInstanz: '1', andereInstanz: '0' },
          beschreibungen: {
            hersteller: '1',
            andereInstanz: '1',
            platzhalter: '1',
            emailAdressen: '1',
          },
        },
      },
    });
  });

  it('counts operations per method, deprecated ones, operationIds and extensions', async () => {
    const result = await run();
    const operations = (result.result as { openapi: { operationen: unknown } })
      .openapi.operationen;
    expect(operations).toMatchObject({
      veraltet: { get: 1, post: 0, delete: 1 },
      operationId: { mit: 2, doppelt: 1 },
      erweiterungen: { 'x-permission': 1 },
      beschreibungen: {
        allgemeineWoerter: '1',
        rechteDerTools: {
          'view alldata in churchdb': '1',
          'view in churchwiki': '0',
        },
      },
    });
    const counted = operations as {
      jeMethode: Record<string, number>;
      operationId: Record<string, number>;
    };
    const total = Object.values(counted.jeMethode).reduce((a, b) => a + b, 0);
    expect(
      (counted.operationId['mit'] ?? 0) + (counted.operationId['ohne'] ?? 0),
    ).toBe(total);
    expect(counted.jeMethode['delete']).toBeGreaterThanOrEqual(2);
  });

  it('names the prefixes only on the test instance', async () => {
    const test = await run();
    const prefixes = (
      test.result as { openapi: { operationen: { getJePraefix: object } } }
    ).openapi.operationen.getJePraefix;
    expect(Object.keys(prefixes)).toEqual(
      expect.arrayContaining(['persons', 'wiki', 'info', 'whoami']),
    );
    const other = await run({ categories: ['gemeinde'] });
    expect(other.code).toBe(exitCodes.ok);
    expect(other.result).toMatchObject({ testinstanz: 'nein' });
    const hidden = Object.keys(
      (other.result as { openapi: { operationen: { getJePraefix: object } } })
        .openapi.operationen.getJePraefix,
    );
    expect(hidden.length).toBe(Object.keys(prefixes).length);
    for (const name of hidden) {
      expect(name).toMatch(/^<prefix#\d+>$/);
    }
    const twice = await run({
      categories: [identificationCategoryName, identificationCategoryName],
    });
    expect(twice.result).toMatchObject({ testinstanz: 'nein' });
  });

  it('reads only the categories, with GET and the token, and nothing if they are not documented', async () => {
    const result = await run();
    expect(result.calls.map((call) => call.url.pathname)).toEqual([
      '/api/wiki/categories',
      '/api/permissions/definitions',
    ]);
    for (const call of result.calls) {
      expect(call.authorization).toMatch(/^Login ct-CANARY-/);
    }
    const without = await run({}, (document) => {
      const paths = { ...document.paths };
      delete paths['/wiki/categories'];
      return { ...document, paths };
    });
    expect(without.code).toBe(exitCodes.ok);
    expect(without.calls.map((call) => call.url.pathname)).toEqual([
      '/api/permissions/definitions',
    ]);
    expect(without.result).toMatchObject({
      testinstanz: 'nicht dokumentiert',
    });
  });

  it('withholds the output if a prefix equals a part of the host', async () => {
    const result = await run({}, (document) => ({
      ...document,
      paths: { ...document.paths, '/example/items': { get: {} } },
    }));
    expect(result.code).toBe(exitCodes.withheld);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
  });
});

describe('10-docs-sources, part rights', () => {
  it('describes the definitions without any of their names or values', async () => {
    const result = await run();
    expect(result.code, result.output.stdout()).toBe(exitCodes.ok);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
    expect(result.output.stdout()).not.toContain(identificationCategoryName);
    expect(result.result).toMatchObject({
      rechte: {
        definitionen: {
          antwort: { status: 200, format: 'JSON' },
          module: {
            churchdb: 'vorhanden',
            churchwiki: 'vorhanden',
            churchcal: 'vorhanden',
            churchcheckin: 'fehlt',
          },
          rechteDerTools: {
            'view alldata in churchdb': 'definiert',
            'view in churchwiki': 'definiert',
            'view category in churchwiki': 'definiert',
            'view category in churchcal': 'definiert',
            'view events in churchservice': 'definiert',
            'view songcategory in churchservice': 'fehlt',
          },
          namen: '2–9',
          werteDerInstanz: { kategorienamen: 'ja', auswahllisten: '1' },
        },
      },
      openapi: {
        operationen: { beschreibungen: { rechteDerDefinitionen: '1' } },
      },
    });
  });

  it('reports a refusal and reads nothing more from it', async () => {
    const result = await run({ definitionsStatus: 403 });
    expect(result.code).toBe(exitCodes.ok);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
    const definitions = (result.result as { rechte: { definitionen: object } })
      .rechte.definitionen;
    expect(definitions).toMatchObject({ antwort: { status: 403 } });
    expect(Object.keys(definitions)).toEqual(['antwort']);
    expect(result.result).toMatchObject({
      openapi: {
        operationen: { beschreibungen: { rechteDerDefinitionen: 'unbekannt' } },
      },
    });
  });

  it('does not call the definitions if the instance does not document them', async () => {
    const result = await run({}, (document) => {
      const paths = { ...document.paths };
      delete paths['/permissions/definitions'];
      return { ...document, paths };
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.calls.map((call) => call.url.pathname)).toEqual([
      '/api/wiki/categories',
    ]);
    expect(result.result).toMatchObject({
      rechte: { definitionen: 'nicht dokumentiert' },
    });
  });

  it('says it cannot compare the categories when it could not read them', async () => {
    const result = await run({ categories: [] });
    expect(result.result).toMatchObject({
      testinstanz: 'nein',
      rechte: {
        definitionen: { werteDerInstanz: { kategorienamen: 'unbekannt' } },
      },
    });
  });
});

describe('the helpers of 10-docs-sources', () => {
  it('finds a right in its module, in either shape, and not in another module', () => {
    const alldata = { module: 'churchdb', right: 'view alldata' } as const;
    expect(definesRight({ churchdb: { 'view alldata': {} } }, alldata)).toBe(
      true,
    );
    expect(
      definesRight([{ module: 'churchdb', auth: 'view alldata' }], alldata),
    ).toBe(true);
    expect(
      definesRight(
        { data: [{ name: 'churchdb', rights: [{ key: 'view alldata' }] }] },
        alldata,
      ),
    ).toBe(true);
    expect(definesRight({ churchgroup: { 'view alldata': {} } }, alldata)).toBe(
      false,
    );
    expect(
      definesRight(
        [
          { module: 'churchgroup', auth: 'view alldata' },
          { module: 'churchdb' },
        ],
        alldata,
      ),
    ).toBe(false);
  });

  it('finds a defined right in a description only as whole words', () => {
    const rights = new Set(['view alldata']);
    expect(namesAny('needs view alldata.', rights)).toBe(true);
    expect(namesAny('needs view alldatax or xview alldata', rights)).toBe(
      false,
    );
    expect(namesAny('view alldata', rights)).toBe(true);
  });

  it('puts every host into its class', () => {
    const instance = hosted('demo-tenant');
    expect(classifyHost(`${hosted('Demo-Tenant')}.`, instance)).toBe(
      'hostDerInstanz',
    );
    expect(classifyHost(hosted('other-tenant'), instance)).toBe(
      'andereInstanz',
    );
    for (const host of [
      'church.tools',
      'www.church.tools',
      'forum.church.tools',
      'churchtools.de',
      'api.churchtools.de',
      'churchtools.academy',
    ]) {
      expect(classifyHost(host, instance), host).toBe('hersteller');
    }
    for (const host of [
      'example.church.tools',
      'example.org',
      'mail.example.com',
      'localhost',
      'host.test',
    ]) {
      expect(classifyHost(host, instance), host).toBe('platzhalter');
    }
    expect(classifyHost('creativecommons.org', instance)).toBe('andererHost');
    expect(classifyHost('churchtools.de.evil.net', instance)).toBe(
      'andererHost',
    );
  });

  it('counts each class of host once per text', () => {
    const counts: HostCounts = {
      texts: 0,
      hosts: {
        hostDerInstanz: 0,
        andereInstanz: 0,
        hersteller: 0,
        platzhalter: 0,
        andererHost: 0,
      },
      mails: 0,
    };
    const instance = hosted('demo-tenant');
    countHosts(
      `https://${hosted('a')} and ${hosted('b')}, max@example.org, ` +
        `see ${instance}X`,
      instance,
      counts,
    );
    countHosts('nothing here', instance, counts);
    expect(counts).toEqual({
      texts: 2,
      hosts: {
        hostDerInstanz: 1,
        andereInstanz: 1,
        hersteller: 0,
        platzhalter: 1,
        andererHost: 0,
      },
      mails: 1,
    });
  });

  it('counts a right of one word only with its module', () => {
    const view = { module: 'churchwiki', right: 'view' } as const;
    const alldata = { module: 'churchdb', right: 'view alldata' } as const;
    expect(namesToolRight('you can view the list', view)).toBe(false);
    expect(namesToolRight('needs view in churchwiki', view)).toBe(true);
    expect(namesToolRight('needs view alldata.', alldata)).toBe(true);
    expect(namesToolRight('needs view alldatax', alldata)).toBe(false);
  });

  it('finds the prefix and rounds sizes', () => {
    expect(prefixOf('/api/persons/{id}')).toBe('persons');
    expect(prefixOf('/system/runtime')).toBe('system');
    expect(prefixOf('/api')).toBe('api');
    expect(sizeOf(undefined)).toBe('0 KiB');
    expect(sizeOf('x'.repeat(10))).toBe('1 KiB');
    expect(sizeOf('x'.repeat(3 * 1024 * 1024))).toBe('3.0 MiB');
  });

  it('knows exactly the rights the reference of the tools names', () => {
    const reference = readFileSync(toolsReference, 'utf8');
    const named = new Set<string>();
    for (const line of reference.split('\n')) {
      if (!line.startsWith('- Rechte in ChurchTools:')) {
        continue;
      }
      for (const match of line.matchAll(/`([^`]+)` in `([^`]+)`/g)) {
        named.add(`${match[1] ?? ''} in ${match[2] ?? ''}`);
      }
    }
    expect([...named].sort()).toEqual(toolRights.map(toolRightName).sort());
  });
});
