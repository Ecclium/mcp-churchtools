// The acceptance question of the docs index: «Welches Recht brauche ich,
// um Gruppenmitglieder zu lesen?» The docs tools answer it over the real
// facts under data/, through the pipeline of the core, as the server runs
// them, and like every test without a connection to the outside (ADR
// 0052). The way is the one the descriptions lay out: search the
// operation, read its rights, read each right. The answer is the one F29
// found: «view alldata» in churchdb, without which the entries are left
// out, and «view groups of grouptype» in churchgroup, without which
// ChurchTools refuses with 403 (ADR 0066).
import { readFileSync } from 'node:fs';

import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  buildDocsIndex,
  type DocsIndex,
  factFiles,
  type FactFileTexts,
  openDocsIndex,
} from '@ecclium/mcp-churchtools-docs-index';
import type { TenantAssignment } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
} from '@ecclium/mcp-churchtools-testkit';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = new URL('../../packages/docs-index/data/', import.meta.url);

function readData(): FactFileTexts {
  const read = (name: string) => readFileSync(new URL(name, dataDir), 'utf8');
  return {
    'SOURCES.json': read(factFiles.sources),
    'operations.json': read(factFiles.operations),
    'rights.json': read(factFiles.rights),
    'academy.json': read(factFiles.academy),
    'operation-rights.json': read(factFiles.operationRights),
  };
}

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const double = createChurchToolsDouble({
  token: loaded.config.churchtoolsToken,
});
let docs: DocsIndex;
let call: (
  name: string,
  input: unknown,
) => Promise<Readonly<Record<string, unknown>>>;

beforeAll(() => {
  // The real facts take seconds to build and open, as the build does.
  docs = openDocsIndex(buildDocsIndex(readData()));
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(new Map()),
    catalog: createToolCatalog({
      core: createCorePlugin({ docs }),
      toolsets: new Set(['docs'] as const),
      plugins: [],
      readOnly: true,
    }),
    audit: Object.freeze({
      record: () => true,
      hasFile: false,
      ready: () => true,
      failures: () => 0,
    }),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: {
      writer: Object.freeze({ write: () => true }),
      minLevel: 'debug',
    },
  });
  call = async (name, input) => {
    const outcome = await pipeline.call(name, input, request());
    if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error.code}`);
    return outcome.data;
  };
}, 60_000);

afterAll(async () => {
  await double.close();
});

// The text inside the data envelope.
const unwrap = (value: unknown): string =>
  String(value)
    .replace(/^<<data-[^>]+>>/u, '')
    .replace(/<<\/data-[^>]+>>$/u, '');

const membersOperation = 'get-groups-id-members';
const membersPath = '/api/groups/{groupId}/members';

describe('the acceptance question over the real facts', () => {
  it('finds the operation that lists the members of a group', async () => {
    const result = await call('ct_docs_search_api', {
      query: 'group members',
      limit: 10,
    });
    const hits = result['hits'] as readonly Record<string, unknown>[];
    expect(hits).toContainEqual(
      expect.objectContaining({
        operationId: membersOperation,
        method: 'GET',
        path: membersPath,
      }),
    );
    // A failed request knows its path with the ID of the group.
    const byPath = await call('ct_docs_get_operation', {
      method: 'GET',
      path: '/api/groups/12/members',
    });
    expect(byPath['operationId']).toBe(membersOperation);
  });

  it('names view alldata and view groups of grouptype with F29', async () => {
    const result = await call('ct_docs_get_operation', {
      operationId: membersOperation,
    });
    const rights = result['rights'] as Record<string, unknown>;
    expect(rights['status']).toBe('needs');
    const needs = rights['needs'] as readonly Record<string, unknown>[];
    const answer = needs.map((need) => ({
      rights: (need['oneOf'] as readonly Record<string, unknown>[]).map(
        (right) => ({
          right: `${String(right['module'])}: ${String(right['name'])}`,
          label: unwrap(right['label']),
        }),
      ),
      withoutThem: need['withoutThem'],
      evidence: (need['evidence'] as readonly Record<string, unknown>[]).map(
        (item) =>
          `${String(item['finding'])} ${String(item['churchToolsVersion'])} ${String(item['shows'])}`,
      ),
    }));
    expect(answer).toEqual([
      {
        rights: [
          {
            right: 'churchdb: view alldata',
            label: 'Personen eines Bereiches sehen',
          },
        ],
        withoutThem: 'entries left out',
        evidence: ['F29 3.137 necessary'],
      },
      {
        rights: [
          {
            right: 'churchgroup: view groups of grouptype',
            label: 'Gruppen eines Gruppentyps sehen – außer versteckte',
          },
        ],
        withoutThem: 'refused with 403',
        evidence: ['F29 3.137 necessary'],
      },
    ]);
    expect(result['path']).toBe(membersPath);
  });

  it.each([
    ['churchdb', 'view alldata'],
    ['churchgroup', 'view groups of grouptype'],
  ])(
    'reads %s: %s with the operation and the help pages that explain it',
    async (module, name) => {
      const result = await call('ct_docs_get_right', { module, name });
      const neededBy = result['neededBy'] as readonly Record<string, unknown>[];
      expect(neededBy.map((item) => item['operationId'])).toContain(
        membersOperation,
      );
      const pages = result['pages'] as readonly Record<string, unknown>[];
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(page['link']).toMatch(/^https:\/\/churchtools\.academy\/de\//u);
      }
    },
  );

  it('reads nothing from ChurchTools on the way', () => {
    expect(double.calls()).toEqual([]);
  });
});
