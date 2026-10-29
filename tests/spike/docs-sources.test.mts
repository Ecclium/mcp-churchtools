// Runs probe 10 against a synthetic instance and a synthetic OpenAPI
// document whose texts are full of canary values (see
// tests/fixtures/README.md). The probe must print counts, classes and
// fixed words only, and the names of prefixes only on the test instance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyHost,
  classifyLink,
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
  academyOrigin,
  hreflangCodes,
  pageFeatures,
  parseRobots,
  robotsAllow,
} from '../../scripts/spike/lib/academy.mts';
import {
  createState,
  instanceId,
  type Environment,
} from '../../scripts/spike/lib/env.mts';
import { identificationCategoryName } from '../../scripts/spike/lib/gate.mts';
import {
  userAgent,
  type FetchFunction,
} from '../../scripts/spike/lib/http.mts';
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

/** One request the synthetic instance or academy received. */
interface Call {
  readonly url: URL;
  readonly authorization: string | null;
  readonly cookie: string | null;
}

/** How the synthetic instance answers. */
interface Answers {
  /** Names of the wiki categories the account sees. */
  readonly categories?: readonly string[];
  /** Status of the definitions of the rights. Default: 200. */
  readonly definitionsStatus?: number;
  /** The robots.txt of the academy. Default: only /wp-admin/ is closed. */
  readonly robots?: string;
  /** The slug of the first section of the academy. Default: `personen`. */
  readonly sectionSlug?: string;
  /** The media type of robots.txt. Default: `text/plain`. */
  readonly robotsType?: string;
  /** Status of robots.txt. Default: 200. */
  readonly robotsStatus?: number;
  /** Whether the lists leave out `X-WP-Total`. */
  readonly withoutTotals?: boolean;
  /** Extra sections, each with one help page. Default: none. */
  readonly extraSections?: number;
}

/** One run of the probe. */
interface Run {
  readonly code: number;
  readonly output: Capture;
  readonly result: unknown;
  readonly calls: readonly Call[];
  /** The pauses the probe asked for, in milliseconds. */
  readonly waits: readonly number[];
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
        post: {
          description:
            'Zur Rechteverwaltung, nach rechts. Alle personen sehen.',
        },
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
    calls.push({
      url: input,
      authorization: headers.get('authorization'),
      cookie: headers.get('cookie'),
    });
    if (input.origin === academyOrigin) {
      return Promise.resolve(syntheticAcademy(canaries, answers, input));
    }
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

// The academy: robots.txt, the overview with its languages, the index of
// the REST interface, two taxonomies and four help pages on two pages of
// the list. The pages carry canary values in their text and in fields the
// probe does not ask for, such as the authors.
function syntheticAcademy(
  canaries: Canaries,
  answers: Answers,
  url: URL,
): Response {
  const json = (body: unknown, total = 1, pages = 1): Response =>
    Response.json(body, {
      headers:
        answers.withoutTotals === true
          ? {}
          : {
              'x-wp-total': String(total),
              'x-wp-totalpages': String(pages),
            },
    });
  const extra = Array.from(
    { length: answers.extraSections ?? 0 },
    (_, index) => index,
  );
  const author = { author: 7, author_info: { name: canaries.personName } };
  const instanceHost = new URL(origin).hostname;
  switch (url.pathname) {
    case '/robots.txt':
      return answers.robotsStatus === 301
        ? new Response(null, {
            status: 301,
            headers: { location: `${origin}/` },
          })
        : new Response(
            answers.robots ??
              'User-agent: *\nDisallow: /wp-admin/\nSitemap: /x.xml\n',
            {
              status: answers.robotsStatus ?? 200,
              headers: { 'content-type': answers.robotsType ?? 'text/plain' },
            },
          );
    case '/de/help/':
      return new Response(
        '<link rel="alternate" hreflang="de" href="/de/help/">' +
          '<link rel="alternate" hreflang="en" href="/en/help/">' +
          '<link rel="alternate" hreflang="x-default" href="/help/">',
        { headers: { 'content-type': 'text/html' } },
      );
    case '/de/wp-json/':
      return json({
        name: canaries.groupName,
        namespaces: ['wp/v2', 'betterdocs', 'wpml/v1'],
        routes: {
          '/wp/v2/docs': {},
          '/wp/v2/doc_category': {},
          '/wp/v2/knowledge_base': {},
        },
      });
    case '/de/wp-json/wp/v2/doc_category':
      return json([
        { id: 1, slug: answers.sectionSlug ?? 'personen', parent: 0 },
        { id: 2, slug: 'personen-suchen', parent: 1 },
        { id: 3, slug: 'rechteverwaltung-verstehen', parent: 0 },
        { id: 4, slug: '%c3%bcber-uns', parent: 0 },
        ...extra.map((index) => ({
          id: 1000 + index,
          slug: `abschnitt-${String(index)}`,
          parent: 0,
        })),
      ]);
    case '/de/wp-json/wp/v2/knowledge_base':
      return json([{ id: 10, slug: 'churchtools', parent: 0 }]);
    case '/de/wp-json/wp/v2/docs':
      return url.searchParams.get('page') === '1'
        ? json(
            [
              {
                id: 101,
                status: 'publish',
                modified_gmt: '2026-10-28T17:55:24',
                doc_category: [2],
                knowledge_base: [10],
                content: {
                  rendered:
                    `<p>${canaries.personName}</p><img src="/a.png">` +
                    '<a href="https://churchtools.academy/de/help/a/">a</a>' +
                    '<a href="/de/help/b/">b</a>' +
                    `<a href="https://${instanceHost}/">i</a>` +
                    `<a href="mailto:${canaries.personEmail}">m</a>`,
                  protected: false,
                },
                ...author,
              },
              {
                id: 102,
                status: 'publish',
                modified_gmt: '2019-03-01T08:00:00',
                doc_category: [3],
                knowledge_base: [],
                content: {
                  rendered: `<table><tr><td>${canaries.groupName}</td></tr></table> siehe ${hosted('demo-tenant')}`,
                  protected: true,
                },
                ...author,
              },
            ],
            4,
            2,
          )
        : json(
            [
              {
                id: 103,
                status: 'private',
                modified_gmt: '2026-01-05T10:00:00',
                doc_category: [4],
                content: {
                  rendered:
                    '<iframe src="https://vimeo.com/1"></iframe><pre>x</pre>' +
                    '<a href="https://www.churchtools.de/">c</a>' +
                    '<a href="https://vimeo.com/1">v</a>',
                  protected: false,
                },
                ...author,
              },
              {
                id: 104,
                status: 'publish',
                modified_gmt: '2026-02-05T10:00:00',
                doc_category: [],
                content: { rendered: 'kurz', protected: false },
                ...author,
              },
              ...extra.map((index) => ({
                id: 2000 + index,
                status: 'publish',
                modified_gmt: '2026-03-01T00:00:00',
                doc_category: [1000 + index],
                content: { rendered: 'x', protected: false },
              })),
            ],
            4,
            2,
          );
    case '/en/wp-json/wp/v2/docs':
      return json([{ id: 1 }], 120, 120);
    default:
      return new Response('', { status: 404 });
  }
}

// Definitions of rights in two shapes: modules as keys with rights as
// keys, and a list of objects with module and right as texts. The labels
// carry canary values, one right lists the wiki categories with their
// names, and `view songcategory` is missing on purpose.
function syntheticDefinitions(canaries: Canaries): unknown {
  return {
    data: {
      churchdb: {
        'view alldata': {
          label: canaries.personName,
          description: 'alle personen sehen',
          type: 'list',
        },
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
  const waits: number[] = [];
  const code = await runProbe(probe, {
    env,
    fetch: instance.fetch,
    io: output.io,
    folder: spikeFolder,
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  const text = output.stdout();
  return {
    code,
    output,
    result: text === '' ? undefined : JSON.parse(text),
    calls: instance.calls,
    waits,
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
    const toInstance = result.calls.filter(
      (call) => call.url.origin === origin,
    );
    expect(toInstance.map((call) => call.url.pathname)).toEqual([
      '/api/wiki/categories',
      '/api/permissions/definitions',
    ]);
    for (const call of toInstance) {
      expect(call.authorization).toMatch(/^Login ct-CANARY-/);
    }
    const without = await run({}, (document) => {
      const paths = { ...document.paths };
      delete paths['/wiki/categories'];
      return { ...document, paths };
    });
    expect(without.code).toBe(exitCodes.ok);
    expect(
      without.calls
        .filter((call) => call.url.origin === origin)
        .map((call) => call.url.pathname),
    ).toEqual(['/api/permissions/definitions']);
    expect(without.result).toMatchObject({
      testinstanz: 'nicht dokumentiert',
    });
  });

  it('registers the size of a long description with the guard', async () => {
    const result = await run({}, (document) => ({
      ...document,
      info: { ...(document['info'] as object), description: 'x'.repeat(2000) },
    }));
    expect(result.code, result.output.stdout()).toBe(exitCodes.ok);
    expect(result.result).toMatchObject({
      openapi: { info: { beschreibung: '2 KiB' } },
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
    expect(
      result.calls
        .filter((call) => call.url.origin === origin)
        .map((call) => call.url.pathname),
    ).toEqual(['/api/wiki/categories']);
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

describe('10-docs-sources, part academy', () => {
  it('describes the help pages with counts, classes and slugs, and none of their texts', async () => {
    const result = await run();
    expect(result.code, result.output.stdout()).toBe(exitCodes.ok);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
    expect(result.output.stdout()).not.toMatch(/vimeo|author/i);
    expect(result.result).toMatchObject({
      academy: {
        robots: {
          status: 200,
          eigeneGruppe: 'nein',
          gruppeFuerAlle: 'ja',
          pfade: { '/de/help/': 'erlaubt', '/de/wp-json/': 'erlaubt' },
          crawlDelay: 'fehlt',
          sitemap: 'ja',
        },
        hilfe: { status: 200, sprachen: ['de', 'en', 'x-default'] },
        schnittstelle: {
          status: 200,
          namensraeume: { 'wp/v2': 'vorhanden', betterdocs: 'vorhanden' },
          routen: { '/wp/v2/docs': 'vorhanden' },
        },
        gelesen: 'ja',
        seiten: {
          gemeldet: 4,
          gelesen: 4,
          veroeffentlicht: 3,
          geschuetzt: 1,
          geaendert: {
            aeltestes: '2019-03',
            neuestes: '2026-10',
            jeJahr: { '2019': 1, '2026': 3 },
          },
          merkmale: { bilder: '1', videos: '1', tabellen: '1', code: '1' },
          links: {
            academy: '1',
            relativ: '1',
            email: '1',
            hostDerInstanz: '1',
            hersteller: '1',
            andererHost: '1',
            andereInstanz: '0',
          },
          hostsImText: { andereInstanz: '1', hostDerInstanz: '0' },
        },
        kategorien: 4,
        abschnitte: {
          personen: { seiten: 1 },
          'rechteverwaltung-verstehen': { seiten: 1 },
          '<abschnitt#1>': { seiten: 1 },
          ohneZuordnung: { seiten: 1 },
        },
        wissensbasen: {
          churchtools: { seiten: 1 },
          ohneZuordnung: { seiten: 3 },
        },
        weitereSprachen: { en: 120 },
      },
    });
  });

  it('sends the academy no token and no cookie, asks for no author, and pauses between requests', async () => {
    const result = await run();
    const toAcademy = result.calls.filter(
      (call) => call.url.origin === academyOrigin,
    );
    expect(toAcademy.map((call) => call.url.pathname)).toEqual([
      '/robots.txt',
      '/de/help/',
      '/de/wp-json/',
      '/de/wp-json/wp/v2/doc_category',
      '/de/wp-json/wp/v2/knowledge_base',
      '/de/wp-json/wp/v2/docs',
      '/de/wp-json/wp/v2/docs',
      '/en/wp-json/wp/v2/docs',
    ]);
    for (const call of toAcademy) {
      expect(call.authorization).toBeNull();
      expect(call.cookie).toBeNull();
      expect(call.url.searchParams.get('_fields') ?? '').not.toMatch(/author/);
    }
    expect(result.waits).toEqual(toAcademy.slice(1).map(() => 3000));
  });

  it('reads nothing more when robots.txt forbids a path it needs', async () => {
    const result = await run({
      robots: 'User-agent: *\nDisallow: /de/wp-json/\n',
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.result).toMatchObject({
      academy: {
        robots: { pfade: { '/de/wp-json/': 'verboten' } },
        gelesen: 'nein',
        grund: 'robots.txt verbietet',
      },
    });
    expect(
      result.calls
        .filter((call) => call.url.origin === academyOrigin)
        .map((call) => call.url.pathname),
    ).toEqual(['/robots.txt']);
  });

  it('follows a group for its own agent before the one for every agent', async () => {
    const result = await run({
      robots: `User-agent: *\nDisallow: /\n\nUser-agent: ${userAgent}\nAllow: /de/\nCrawl-delay: 5\n`,
    });
    expect(result.result).toMatchObject({
      academy: {
        robots: { eigeneGruppe: 'ja', crawlDelay: 5 },
        gelesen: 'ja',
      },
    });
    expect(result.waits.slice(1).every((wait) => wait === 5000)).toBe(true);
  });

  it('withholds the output if the slug of a section equals a part of the host', async () => {
    const result = await run({ sectionSlug: 'example' });
    expect(result.code).toBe(exitCodes.withheld);
    expect(leaks(result.output, result.forbidden)).toEqual([]);
  });

  it('treats a page in place of robots.txt as unreadable', async () => {
    const result = await run({ robotsType: 'text/html; charset=UTF-8' });
    expect(result.result).toMatchObject({
      academy: { gelesen: 'nein', grund: 'robots.txt nicht lesbar' },
    });
    expect(
      result.calls.filter((call) => call.url.origin === academyOrigin),
    ).toHaveLength(1);
  });

  it('keeps the parts about the instance when a request to the academy fails', async () => {
    const result = await run({ robotsStatus: 301 });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.result).toMatchObject({
      testinstanz: 'ja',
      openapi: { format: 'OpenAPI 3' },
      rechte: { definitionen: { antwort: { status: 200 } } },
      academy: { gelesen: 'nein', grund: 'Fehler', fehler: 'HTTP_REDIRECT' },
    });
  });

  it('asks robots.txt about each page of a list with its query', async () => {
    const result = await run({ robots: 'User-agent: *\nDisallow: /*page=2\n' });
    expect(result.result).toMatchObject({
      academy: { gelesen: 'nein', grund: 'robots.txt verbietet' },
    });
    const docs = result.calls.filter(
      (call) => call.url.pathname === '/de/wp-json/wp/v2/docs',
    );
    expect(docs.map((call) => call.url.searchParams.get('page'))).toEqual([
      '1',
    ]);
  });

  it('says unbekannt when the academy reports no total', async () => {
    const result = await run({ withoutTotals: true });
    expect(result.result).toMatchObject({
      academy: {
        gelesen: 'ja',
        seiten: { gemeldet: 'unbekannt', gelesen: 2 },
        weitereSprachen: { en: 'unbekannt' },
      },
    });
  });

  it('names at most a fixed number of sections', async () => {
    const result = await run({ extraSections: 110 });
    expect(result.code).toBe(exitCodes.ok);
    const sections = (
      result.result as { academy: { abschnitte: Record<string, unknown> } }
    ).academy.abschnitte;
    expect(sections['weitere']).toBe('10–99');
    expect(Object.keys(sections)).toHaveLength(101);
  });

  it('stops at a Crawl-delay longer than it may wait', async () => {
    const result = await run({ robots: 'User-agent: *\nCrawl-delay: 60\n' });
    expect(result.result).toMatchObject({
      academy: { gelesen: 'nein', grund: 'Crawl-delay zu lang' },
    });
    expect(
      result.calls.filter((call) => call.url.origin === academyOrigin),
    ).toHaveLength(1);
  });
});

describe('the helpers of the part academy', () => {
  it('reads robots.txt: the longest rule wins, an allow wins a tie, * and $ match', () => {
    const rules = parseRobots(
      [
        '# comment',
        'User-agent: other',
        'Disallow: /',
        '',
        'User-agent: *',
        'Disallow: /de/',
        'Allow: /de/help/',
        'Disallow: /*.php$',
        'Disallow: /de/x',
        'Allow: /de/x',
        'Disallow:',
      ].join('\r\n'),
      userAgent,
    );
    expect(rules.ownGroup).toBe(false);
    expect(rules.starGroup).toBe(true);
    expect(robotsAllow(rules, '/de/help/')).toBe(true);
    expect(robotsAllow(rules, '/de/wp-json/')).toBe(false);
    expect(robotsAllow(rules, '/en/a.php')).toBe(false);
    expect(robotsAllow(rules, '/en/a.php/b')).toBe(true);
    expect(robotsAllow(rules, '/de/x')).toBe(true);
    expect(robotsAllow(rules, '/robots.txt')).toBe(true);
    expect(robotsAllow(parseRobots('', userAgent), '/de/')).toBe(true);
  });

  it('reads robots.txt as RFC 9309 asks: other records, encoded octets, the query', () => {
    const split = parseRobots(
      `User-agent: ${userAgent}\nHost: example.org\nUser-agent: *\nDisallow: /de/\n`,
      userAgent,
    );
    expect(split.ownGroup).toBe(true);
    expect(robotsAllow(split, '/de/help/')).toBe(false);
    const encoded = parseRobots('User-agent: *\nDisallow: /%64e/\n', userAgent);
    expect(robotsAllow(encoded, '/de/help/')).toBe(false);
    expect(robotsAllow(encoded, '/%64e/help/')).toBe(false);
    const query = parseRobots('User-agent: *\nDisallow: /*?\n', userAgent);
    expect(robotsAllow(query, '/de/wp-json/')).toBe(true);
    expect(robotsAllow(query, '/de/wp-json/wp/v2/docs?page=1')).toBe(false);
    const many = 'User-agent: *\nCrawl-delay: 1\n'.repeat(200_000);
    expect(
      parseRobots(`${many}User-agent: *\nCrawl-delay: 4\n`, userAgent)
        .crawlDelay,
    ).toBe(4);
  });

  it('strips the tags of a page in linear time', () => {
    const started = performance.now();
    const features = pageFeatures(`${'<'.repeat(300_000)}x`);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(features.text.endsWith('x')).toBe(true);
  });

  it('finds the languages, the features and the links of a page', () => {
    expect(
      hreflangCodes(
        '<link hreflang="DE"><link rel="x" hreflang=\'en-GB\'><link hreflang="toolongcode">',
      ),
    ).toEqual(['de', 'en-gb']);
    const features = pageFeatures(
      '<p>Text <b>fett</b></p><img src="a"><a href="/x">y</a><code>z</code>',
    );
    expect(features).toEqual({
      images: true,
      videos: false,
      tables: false,
      code: true,
      links: ['/x'],
      text: 'Text fett y z',
    });
    const instance = 'example.church.tools';
    expect(classifyLink('/de/help/', instance)).toBe('relativ');
    expect(classifyLink('#top', instance)).toBe('relativ');
    expect(classifyLink('MAILTO:x@example.org', instance)).toBe('email');
    expect(classifyLink('https://churchtools.academy/de/', instance)).toBe(
      'academy',
    );
    expect(classifyLink('//churchtools.academy/de/', instance)).toBe('academy');
    expect(classifyLink(`https://${instance}/`, instance)).toBe(
      'hostDerInstanz',
    );
    expect(classifyLink(`https://${hosted('other')}/`, instance)).toBe(
      'andereInstanz',
    );
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
