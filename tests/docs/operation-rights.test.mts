// The mapping of operations to rights over the real facts (ADR 0066). The
// checks of the package hold the form and what the document and the help
// pages say; here what only the repository can see: that every finding a
// pairing or a label cites stands in docs/research/churchtools-api.md and
// names the operation and the right, that every read of the client and
// every right of the tools has its place, and that the files under data/
// are what the mapping by hand gives.
import { readFileSync } from 'node:fs';

import {
  type FactFileTexts,
  factFiles,
  type Facts,
  namesRight,
  type NeedEvidence,
  type PlainEvidence,
  parseFactFiles,
  type RightRef,
} from '@ecclium/mcp-churchtools-docs-index';
import type {
  PluginHost,
  ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import { describe, expect, it } from 'vitest';

import {
  operationRightsText,
  rightsText,
} from '../../scripts/docs/lib/files.mts';
import {
  applyMapping,
  defaultMappingFile,
  readMapping,
} from '../../scripts/docs/lib/mapping.mts';

const root = new URL('../../', import.meta.url);
const dataDir = new URL('packages/docs-index/data/', root);

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

const texts = readData();
const facts: Facts = parseFactFiles(texts);
const research = readFileSync(
  new URL('docs/research/churchtools-api.md', root),
  'utf8',
);

// A finding by its number runs from its bold start to the next finding or
// heading, a further finding is its one item of the list.
function findingText(id: string): string | undefined {
  const lines = research.split('\n');
  const start = lines.findIndex(
    (line) =>
      line.startsWith(`**${id},`) ||
      line.startsWith(`- **${id} (`) ||
      line.startsWith(`- **${id}:`),
  );
  if (start === -1) {
    return undefined;
  }
  const block = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (
      /^\*\*F\d+,/.test(line) ||
      line.startsWith('#') ||
      line.startsWith('- **')
    ) {
      break;
    }
    block.push(line);
  }
  return block.join('\n');
}

// Paths as the findings write them, with or without /api and with any
// name in a placeholder, which the document and the findings name apart.
function plainPath(path: string): string {
  return path.replace(/^\/api(?=\/)/, '').replace(/\{[^}]*\}/g, '{}');
}

function namesPath(text: string, path: string): boolean {
  const wanted = plainPath(path);
  const found = text.matchAll(
    /`(?:GET |POST |PUT |PATCH |DELETE )?(\/[^`\s]*)`/g,
  );
  return [...found].some((match) => plainPath(match[1] ?? '') === wanted);
}

const pathOf = new Map(
  facts.operations.entries.map((operation) => [
    operation.operationId,
    operation.path,
  ]),
);
const describedOf = new Map(
  facts.operations.entries.map((operation) => [
    operation.operationId,
    `${operation.summary ?? ''} ${operation.description ?? ''}`,
  ]),
);
const pageOf = new Map(
  facts.academy.entries.map((page) => [page.path, page.text]),
);

// Whether a piece of evidence names the right, as far as it can be read.
function evidenceNames(
  evidence: NeedEvidence | PlainEvidence,
  operationId: string,
  right: RightRef,
): boolean {
  switch (evidence.kind) {
    case 'finding':
      return (findingText(evidence.id) ?? '').includes(right.name);
    case 'openapi':
      return namesRight(describedOf.get(operationId) ?? '', right.name);
    case 'academy':
      return (pageOf.get(evidence.page) ?? '').includes(`(${right.name})`);
  }
}

describe('the mapping of operations to rights', () => {
  it('cites only findings that name the operation', () => {
    const missing: string[] = [];
    for (const entry of facts.operationRights.entries) {
      const path = pathOf.get(entry.operationId) ?? '';
      const evidence = [
        ...('needs' in entry
          ? entry.needs.flatMap((need) => need.evidence)
          : []),
        ...('none' in entry ? entry.none : []),
        ...('notNeeded' in entry
          ? (entry.notNeeded ?? []).flatMap((item) => item.evidence)
          : []),
      ];
      for (const item of evidence) {
        if (item.kind === 'finding') {
          const text = findingText(item.id);
          if (text === undefined || !namesPath(text, path)) {
            missing.push(`${entry.operationId} ${item.id}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('names every right of a pairing in at least one of its pieces of evidence', () => {
    const unnamed: string[] = [];
    for (const entry of facts.operationRights.entries) {
      if ('needs' in entry) {
        for (const need of entry.needs) {
          for (const right of need.rights) {
            if (
              !need.evidence.some((item) =>
                evidenceNames(item, entry.operationId, right),
              )
            ) {
              unnamed.push(
                `${entry.operationId} ${right.module}: ${right.name}`,
              );
            }
          }
        }
      }
      if ('notNeeded' in entry) {
        for (const item of entry.notNeeded ?? []) {
          if (
            !item.evidence.some((piece) =>
              evidenceNames(piece, entry.operationId, item.right),
            )
          ) {
            unnamed.push(
              `${entry.operationId} ${item.right.module}: ${item.right.name}`,
            );
          }
        }
      }
    }
    expect(unnamed).toEqual([]);
  });

  it('takes a label from a finding only if the finding names it with the right', () => {
    const unnamed = facts.rights.entries.flatMap((right) => {
      const { label } = right;
      if (label === undefined || !('finding' in label)) {
        return [];
      }
      const text = findingText(label.finding) ?? '';
      return text.includes(label.text) && text.includes(right.name)
        ? []
        : [`${right.module}: ${right.name}`];
    });
    expect(unnamed).toEqual([]);
  });

  it('has an entry for every operation of the client', () => {
    const contract = JSON.parse(
      readFileSync(
        new URL('packages/core/src/churchtools/contract.json', root),
        'utf8',
      ),
    ) as Record<string, { method?: string; path?: string }>;
    const mapped = new Set(
      facts.operationRights.entries.map((entry) => entry.operationId),
    );
    const reads = Object.entries(contract).flatMap(([name, entry]) =>
      entry.method === undefined || entry.path === undefined
        ? []
        : [{ name, method: entry.method, path: plainPath(entry.path) }],
    );
    // Event and assignments read the same operation.
    expect(reads).toHaveLength(28);
    const found = reads.map((read) => {
      const operations = facts.operations.entries.filter(
        (operation) =>
          operation.method === read.method &&
          plainPath(operation.path) === read.path,
      );
      return {
        name: read.name,
        operationIds: operations.map(({ operationId }) => operationId),
      };
    });
    expect(
      found.filter(({ operationIds }) => operationIds.length !== 1),
    ).toEqual([]);
    const ids = new Set(found.flatMap(({ operationIds }) => operationIds));
    expect(ids.size).toBe(27);
    expect([...ids].filter((id) => !mapped.has(id))).toEqual([]);
  });

  it('holds every right the tools name in their metadata', () => {
    const tools: ToolDefinition[] = [];
    const host = {
      addTool: (tool: ToolDefinition) => {
        tools.push(tool);
      },
      addPrompt: () => undefined,
    } as unknown as PluginHost;
    createCorePlugin().register(host);
    expect(tools).toHaveLength(24);
    const known = new Set(
      facts.rights.entries.map(({ module, name }) => `${module}: ${name}`),
    );
    const named = [
      ...new Set(
        tools.flatMap((tool) =>
          tool.meta.requiredRights.map(
            ({ module, right }) => `${module}: ${right}`,
          ),
        ),
      ),
    ].sort();
    expect(named).toHaveLength(11);
    expect(named.filter((right) => !known.has(right))).toEqual([]);
  });

  it('stands under data/ as the mapping by hand gives it', () => {
    const mapped = applyMapping(
      readMapping(readFileSync(defaultMappingFile, 'utf8')),
      {
        rights: facts.rights.entries.map(({ module, name, kind }) => ({
          module,
          name,
          kind,
          pages: [],
        })),
        operationIds: facts.operations.entries.map(
          ({ operationId }) => operationId,
        ),
        academy: facts.academy.entries,
      },
    );
    expect(rightsText(mapped.rights)).toBe(texts['rights.json']);
    expect(operationRightsText(mapped.operationRights)).toBe(
      texts['operation-rights.json'],
    );
  });

  it('answers which rights read the members of a group, as F29 found', () => {
    const entry = facts.operationRights.entries.find(
      ({ operationId }) => operationId === 'get-groups-id-members',
    );
    expect(entry !== undefined && 'needs' in entry ? entry.needs : []).toEqual([
      {
        rights: [{ module: 'churchdb', name: 'view alldata' }],
        without: 'omitted',
        evidence: [
          { kind: 'finding', id: 'F29', version: '3.137', shows: 'necessary' },
        ],
      },
      {
        rights: [{ module: 'churchgroup', name: 'view groups of grouptype' }],
        without: 'refused',
        evidence: [
          { kind: 'finding', id: 'F29', version: '3.137', shows: 'necessary' },
        ],
      },
    ]);
  });
});
