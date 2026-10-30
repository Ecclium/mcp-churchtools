import {
  syntheticFactFiles,
  syntheticRightsPage,
  syntheticThingsPage,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { buildDocsIndex } from './artifact.js';
import { defaultBuildLocations, readFactFiles } from './build/files.js';
import {
  type Attribution,
  type DocsIndex,
  findingsPath,
  openApiDocumentPath,
  openDocsIndex,
  permissionsPath,
} from './docs-index.js';

// The docs index as the tools use it (ADR 0066): searches and lookups over
// synthetic facts, each result with its attribution (ADR 0027).

const index: DocsIndex = openDocsIndex(buildDocsIndex(syntheticFactFiles()));

const academyLink = (path: string) => `https://churchtools.academy${path}`;

function expectAttribution(attribution: Attribution): void {
  expect(attribution.title).not.toBe('');
  if (attribution.source === 'finding') {
    expect(attribution.path).toBe(findingsPath);
    expect(attribution.churchToolsVersion).toMatch(/^\d+\.\d+/);
    return;
  }
  expect(attribution.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  if (attribution.source === 'academy') {
    expect(attribution.link).toMatch(/^https:\/\/churchtools\.academy\/de\//);
  } else {
    expect(attribution.path).toMatch(/^\/[a-z/.]+$/);
  }
}

describe('openDocsIndex', () => {
  it('searches only the operations asked for', () => {
    const all = index.searchOperations('members of a thing', 5);
    expect(all.length).toBeGreaterThan(1);
    const other = all[1]?.operationId ?? '';
    expect(
      index
        .searchOperations('members of a thing', 5, new Set([other]))
        .map((hit) => hit.operationId),
    ).toEqual([other]);
    expect(index.searchOperations('members of a thing', 5, new Set())).toEqual(
      [],
    );
  });

  it('finds the operation for members of a thing', () => {
    const [first] = index.searchOperations('members of a thing', 5);
    expect(first).toEqual({
      operationId: 'getSyntheticThingMembers',
      method: 'get',
      path: '/synthetic/things/{thingId}/members',
      summary: 'List the members of a synthetic thing',
      deprecated: false,
      attribution: {
        source: 'openapi',
        title: 'getSyntheticThingMembers',
        path: openApiDocumentPath,
        retrieved: '2026-10-29',
        documentVersion: '0.1.0',
        churchToolsVersion: '3.138',
        license: 'CC BY 4.0',
        adapted: true,
      },
    });
  });

  it('answers which right reads the members of a thing', () => {
    const [first] = index.searchRights(
      'Welches Recht brauche ich, um Mitglieder eines Dings zu lesen?',
      5,
    );
    expect(first?.name).toBe('view thing members');
    expect(first?.label).toBe('Mitglieder der Dinge sehen');
    expect(first?.attributions).toEqual([
      {
        source: 'permissions',
        title: 'synthetic: view thing members',
        path: permissionsPath,
        retrieved: '2026-10-28',
        churchToolsVersion: '3.137',
      },
      {
        source: 'academy',
        title: 'Rechte für Dinge',
        link: academyLink(syntheticRightsPage),
        retrieved: '2026-10-27',
      },
    ]);
  });

  it('looks up a right with the pages that explain it', () => {
    const right = index.getRight('synthetic', 'view thing members');
    expect(right?.fact.kind).toBe('list');
    expect(right?.pages).toEqual([
      {
        path: syntheticRightsPage,
        attribution: {
          source: 'academy',
          title: 'Rechte für Dinge',
          link: academyLink(syntheticRightsPage),
          retrieved: '2026-10-27',
        },
      },
      {
        path: syntheticThingsPage,
        attribution: {
          source: 'academy',
          title: 'Dinge verwalten',
          link: academyLink(syntheticThingsPage),
          retrieved: '2026-10-27',
        },
      },
    ]);
    expect(index.getRight('synthetic', 'view nothing')).toBeUndefined();
    expect(index.getRight('other', 'view thing members')).toBeUndefined();
  });

  it('finds a help page by a part of a compound word', () => {
    expect(
      index.searchAcademy('Mitglieder', 5).map(({ path }) => path),
    ).toEqual([syntheticRightsPage, syntheticThingsPage]);
    const [hit] = index.searchAcademy('Gruppenmitglieder', 5);
    expect(hit).toEqual({
      path: syntheticThingsPage,
      title: 'Dinge verwalten',
      section: 'synthetisch',
      attribution: {
        source: 'academy',
        title: 'Dinge verwalten',
        link: academyLink(syntheticThingsPage),
        retrieved: '2026-10-27',
      },
    });
  });

  it('names the rights an operation needs, with their evidence', () => {
    const members = index.getOperation('getSyntheticThingMembers');
    expect(members?.rights).toEqual({
      operationId: 'getSyntheticThingMembers',
      needs: [
        {
          rights: [{ module: 'synthetic', name: 'view thing members' }],
          without: 'omitted',
          evidence: [
            { kind: 'academy', page: syntheticRightsPage },
            {
              kind: 'finding',
              id: 'Mitglieder ohne Recht',
              version: '3.137',
              shows: 'sufficient',
            },
            { kind: 'openapi' },
          ],
        },
        {
          rights: [{ module: 'synthetic', name: 'view things' }],
          evidence: [
            { kind: 'finding', id: 'F1', version: '3.137', shows: 'necessary' },
          ],
        },
      ],
    });
    expect(index.getOperation('listSyntheticThings')?.rights).toEqual({
      operationId: 'listSyntheticThings',
      none: [{ kind: 'finding', id: 'F1', version: '3.137' }],
    });
    expect(
      Object.isFrozen(index.getOperation('deleteSyntheticThing')?.rights),
    ).toBe(true);
  });

  it('names the operations that need a right and those that do not', () => {
    const things = index.getRight('synthetic', 'view things');
    expect(
      things?.neededBy.map(({ operationId, method, path, need }) => [
        operationId,
        method,
        path,
        need.rights.length,
      ]),
    ).toEqual([
      ['getSyntheticThing', 'get', '/synthetic/things/{thingId}', 1],
      [
        'getSyntheticThingMembers',
        'get',
        '/synthetic/things/{thingId}/members',
        1,
      ],
      ['postSyntheticThing', 'post', '/synthetic/things', 2],
    ]);
    expect(things?.notNeededBy).toEqual([]);
    const view = index.getRight('synthetic', 'view');
    expect(view?.neededBy).toEqual([]);
    expect(view?.notNeededBy).toEqual([
      {
        operationId: 'getSyntheticThing',
        method: 'get',
        path: '/synthetic/things/{thingId}',
        notNeeded: {
          right: { module: 'synthetic', name: 'view' },
          evidence: [{ kind: 'finding', id: 'F1', version: '3.137' }],
        },
      },
    ]);
    expect(Object.isFrozen(things?.neededBy[0])).toBe(true);
  });

  it('attributes a label from a finding to that finding, not to a page', () => {
    const right = index.getRight('synthetic', 'edit things');
    expect(right?.fact.label).toEqual({
      text: 'Dinge bearbeiten',
      finding: 'F2',
      version: '3.137',
    });
    expect(right?.attributions.slice(1)).toEqual([
      {
        source: 'finding',
        title: 'F2',
        path: findingsPath,
        churchToolsVersion: '3.137',
      },
    ]);
    expect(right?.attributions[0]?.source).toBe('permissions');
  });

  it('finds operations by method and path as a request writes them', () => {
    const find = (method: string, path: string) =>
      index.findOperationsByPath(method, path);
    expect(find('get', '/synthetic/things/{thingId}')).toEqual([
      'getSyntheticThing',
    ]);
    expect(find('get', '/api/synthetic/things/12/members')).toEqual([
      'getSyntheticThingMembers',
    ]);
    expect(find('get', '/synthetic/things/{id}/members/')).toEqual([
      'getSyntheticThingMembers',
    ]);
    expect(find('get', '/api/synthetic/things')).toEqual([
      'listSyntheticThings',
    ]);
    expect(find('post', '/synthetic/things')).toEqual(['postSyntheticThing']);
    expect(find('delete', '/synthetic/things/7')).toEqual([
      'deleteSyntheticThing',
    ]);
    // A fixed part fits only itself, a placeholder only a value or a
    // placeholder, and the method counts.
    for (const [method, path] of [
      ['get', '/synthetic/thing/12'],
      ['get', '/synthetic/things/12/members/3'],
      ['get', '/synthetic/{things}'],
      ['get', '/synthetic/things//members'],
      ['get', '/synthetic/things/a{b}/members'],
      ['put', '/synthetic/things/12'],
      ['get', 'synthetic/things'],
      ['get', '/synthetic/things?limit=5'],
      ['get', '/apis/synthetic/things'],
    ] as const) {
      expect(find(method, path), path).toEqual([]);
    }
    expect(Object.isFrozen(find('get', '/synthetic/things'))).toBe(true);
  });

  it('looks up an operation and a help page with their text', () => {
    const operation = index.getOperation('getSyntheticThing');
    expect(operation?.fact.responses.map(({ status }) => status)).toEqual([
      '200',
      '404',
    ]);
    expect(operation?.attribution.title).toBe('getSyntheticThing');
    expect(index.getOperation('getNothing')).toBeUndefined();
    const page = index.getAcademyPage(syntheticThingsPage);
    expect(page?.fact.text).toContain('Person A');
    expect(index.getAcademyPage('/de/help/fehlt/')).toBeUndefined();
  });

  it('attributes every result of every search and lookup', () => {
    const queries = ['thing', 'Dinge', 'sehen', 'synthetic', 'Rechte'];
    for (const query of queries) {
      for (const hit of index.searchOperations(query, 100)) {
        expectAttribution(hit.attribution);
        expectAttribution(
          index.getOperation(hit.operationId)?.attribution as Attribution,
        );
      }
      for (const hit of index.searchRights(query, 100)) {
        expect(hit.attributions.length).toBeGreaterThan(0);
        hit.attributions.forEach(expectAttribution);
      }
      for (const hit of index.searchAcademy(query, 100)) {
        expectAttribution(hit.attribution);
        expectAttribution(
          index.getAcademyPage(hit.path)?.attribution as Attribution,
        );
      }
    }
  });

  it('gives frozen results and facts', () => {
    const operation = index.getOperation('getSyntheticThingMembers');
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(operation?.fact.parameters[0])).toBe(true);
    expect(
      Object.isFrozen(index.searchRights('Dinge', 5)[0]?.attributions),
    ).toBe(true);
  });

  it('opens the facts under data/ and finds an operation, a right and a help page in them', () => {
    const real = openDocsIndex(
      buildDocsIndex(readFactFiles(defaultBuildLocations().dataDir)),
    );
    expect(
      real.searchOperations('group members', 10).map((hit) => hit.operationId),
    ).toContain('get-groups-id-members');
    // The two paths of the document of one form both fit a value; a fixed
    // part wins over a placeholder.
    expect(real.findOperationsByPath('get', '/api/groups/12/members')).toEqual([
      'get-groups-id-members',
    ]);
    expect(real.findOperationsByPath('get', '/groups/members')).toEqual([
      'get-groups-members',
    ]);
    expect(real.findOperationsByPath('get', '/tags/12')).toEqual([
      'get-tags-domainType',
      'get-tags-tagId',
    ]);
    expect(
      real
        .searchRights('view group', 10)
        .map((hit) => `${hit.module}: ${hit.name}`),
    ).toContain('churchgroup: view group');
    const pages = real.searchAcademy('Gruppen', 10);
    expect(pages.length).toBeGreaterThan(0);
    pages.forEach((hit) => {
      expectAttribution(hit.attribution);
    });
    // The real facts take seconds to build and open, more on a runner of CI
    // with coverage than the default of five seconds allows.
  }, 60_000);
});
