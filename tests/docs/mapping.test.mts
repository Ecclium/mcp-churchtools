// Tests of the mapping by hand that pnpm docs:refresh carries into the
// facts (ADR 0066): its form, its order and its references, and the run
// with --nur-zuordnung, which reads no source. The facts are the synthetic
// ones of testkit; the result must pass the checks of the package.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  parseFactFiles,
} from '@ecclium/mcp-churchtools-docs-index';
import {
  syntheticFactFiles,
  syntheticFacts,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  applyMapping,
  mappingFormat,
  readMapping,
} from '../../scripts/docs/lib/mapping.mts';
import { mainMapping, refreshMapping } from '../../scripts/docs/refresh.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import { exitCodes } from '../../scripts/spike/lib/output.mts';

// The mapping of the synthetic facts, as a person writes it: the rights
// without their kind, which comes from the answer of the instance.
function syntheticMapping(): Record<string, unknown> {
  const facts = syntheticFacts();
  return {
    format: mappingFormat,
    rights: facts.rights.entries.map(({ module, name, label, pages }) => ({
      module,
      name,
      ...(label === undefined ? {} : { label }),
      pages,
    })),
    operations: facts.operationRights.entries,
  };
}

// The facts as the refresh writes them before the mapping: rights without
// labels and pages, no pairings.
function dataDir(): URL {
  const folder = pathToFileURL(`${mkdtempSync(join(tmpdir(), 'docs-data-'))}/`);
  const facts = syntheticFacts();
  const texts = syntheticFactFiles({
    ...facts,
    rights: {
      ...facts.rights,
      entries: facts.rights.entries.map(({ module, name, kind }) => ({
        module,
        name,
        kind,
        pages: [],
      })),
    },
    operationRights: { ...facts.operationRights, entries: [] },
  });
  for (const [name, text] of Object.entries(texts)) {
    writeFileSync(new URL(name, folder), text);
  }
  return folder;
}

function mappingFile(mapping: unknown): URL {
  const file = pathToFileURL(
    join(mkdtempSync(join(tmpdir(), 'docs-mapping-')), 'rights-mapping.json'),
  );
  writeFileSync(file, JSON.stringify(mapping, null, 2));
  return file;
}

function placeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SpikeError) {
      return error.where;
    }
    throw error;
  }
  return undefined;
}

const facts = () => {
  const synthetic = syntheticFacts();
  return {
    rights: synthetic.rights.entries.map(({ module, name, kind }) => ({
      module,
      name,
      kind,
      pages: [],
    })),
    operationIds: synthetic.operations.entries.map(
      ({ operationId }) => operationId,
    ),
    academy: synthetic.academy.entries,
  };
};

describe('pnpm docs:refresh --nur-zuordnung', () => {
  it('writes the labels and the pairings, sorted, so that they pass the checks', () => {
    const data = dataDir();
    const before = readFileSync(new URL('operations.json', data), 'utf8');
    const counts = refreshMapping(data, mappingFile(syntheticMapping()));
    expect(counts).toEqual({
      refresh: 'zuordnung',
      zuordnung: {
        mitBezeichnung: 4,
        mitSeiten: 4,
        brauchenRechte: 3,
        ohneRecht: 1,
        offen: 1,
      },
    });
    const read = (name: string) => readFileSync(new URL(name, data), 'utf8');
    const checked = parseFactFiles({
      'SOURCES.json': read('SOURCES.json'),
      'operations.json': read('operations.json'),
      'rights.json': read('rights.json'),
      'academy.json': read('academy.json'),
      'operation-rights.json': read('operation-rights.json'),
    });
    const synthetic = syntheticFacts();
    expect(checked.rights.entries).toEqual(synthetic.rights.entries);
    expect(checked.operationRights.entries).toEqual(
      synthetic.operationRights.entries,
    );
    // Only the two files of the mapping change.
    expect(read('operations.json')).toBe(before);
  });

  it('gives the same bytes a second time', () => {
    const data = dataDir();
    const file = mappingFile(syntheticMapping());
    refreshMapping(data, file);
    const first = readFileSync(new URL('rights.json', data), 'utf8');
    refreshMapping(data, file);
    expect(readFileSync(new URL('rights.json', data), 'utf8')).toBe(first);
    expect(first).toBe(canonicalJson(JSON.parse(first) as unknown));
  });

  it('prints the counts, or the place of a mistake and writes nothing', () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    };
    expect(mainMapping(io, dataDir(), mappingFile(syntheticMapping()))).toBe(
      exitCodes.ok,
    );
    expect(JSON.parse(out.join(''))).toMatchObject({ refresh: 'zuordnung' });

    const data = dataDir();
    const rights = readFileSync(new URL('rights.json', data), 'utf8');
    const broken = syntheticMapping();
    broken['format'] = 'ecclium.docs.rights-mapping.v0';
    expect(mainMapping(io, data, mappingFile(broken))).toBe(
      exitCodes.configuration,
    );
    expect(err.join('')).toContain('Stelle: mapping.format');
    expect(readFileSync(new URL('rights.json', data), 'utf8')).toBe(rights);
  });
});

describe('pnpm docs:refresh --nur-zuordnung with an instance', () => {
  const hosted = (label: string): string =>
    [label, 'church', 'tools'].join('.');

  it('refuses texts that name the instance and writes nothing', () => {
    const data = dataDir();
    const rights = readFileSync(new URL('rights.json', data), 'utf8');
    const mapping = syntheticMapping();
    const operations = mapping['operations'] as { open?: string }[];
    const unmapped = operations[0];
    if (unmapped !== undefined) {
      unmapped.open = 'An der Gemeindewiese geprüft.';
    }
    const io = { stdout: () => undefined, stderr: () => undefined };
    const env = {
      ECCLIUM_SPIKE_BASE_URL: `https://${hosted('gemeindewiese')}`,
    };
    expect(mainMapping(io, data, mappingFile(mapping), env)).not.toBe(
      exitCodes.ok,
    );
    expect(readFileSync(new URL('rights.json', data), 'utf8')).toBe(rights);
    // Without the instance the same text passes.
    expect(mainMapping(io, data, mappingFile(mapping))).toBe(exitCodes.ok);
  });

  it('refuses an address that is not https', () => {
    const err: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (text: string) => err.push(text),
    };
    expect(
      mainMapping(io, dataDir(), mappingFile(syntheticMapping()), {
        ECCLIUM_SPIKE_BASE_URL: 'http://example.church.tools',
      }),
    ).toBe(exitCodes.configuration);
  });
});

describe('readMapping', () => {
  it.each([
    ['text that is not JSON', '{', 'mapping.json'],
    [
      'a list out of order',
      JSON.stringify({
        ...syntheticMapping(),
        operations: [...syntheticFacts().operationRights.entries].reverse(),
      }),
      'mapping.operations[1]',
    ],
    [
      'an operation mapped twice',
      JSON.stringify({
        ...syntheticMapping(),
        operations: [
          ...syntheticFacts().operationRights.entries,
          syntheticFacts().operationRights.entries[4],
        ],
      }),
      'mapping.operations[5]',
    ],
    [
      'an unknown field',
      JSON.stringify({ ...syntheticMapping(), extra: true }),
      'mapping.file',
    ],
    [
      'a pairing without evidence',
      JSON.stringify({
        format: mappingFormat,
        rights: [],
        operations: [
          {
            operationId: 'getSyntheticThing',
            needs: [{ rights: [{ module: 'synthetic', name: 'view' }] }],
          },
        ],
      }),
      'mapping.operations[0].needs[0]',
    ],
    [
      'an unknown result without the right',
      JSON.stringify({
        format: mappingFormat,
        rights: [],
        operations: [
          {
            operationId: 'getSyntheticThing',
            needs: [
              {
                rights: [{ module: 'synthetic', name: 'view' }],
                without: 'empty',
                evidence: [{ kind: 'openapi' }],
              },
            ],
          },
        ],
      }),
      'mapping.operations[0].needs[0].without',
    ],
    [
      'a help page as evidence that a right is not needed',
      JSON.stringify({
        format: mappingFormat,
        rights: [],
        operations: [
          {
            operationId: 'getSyntheticThing',
            open: 'Offen.',
            notNeeded: [
              {
                right: { module: 'synthetic', name: 'view' },
                evidence: [{ kind: 'academy', page: '/de/help/x/' }],
              },
            ],
          },
        ],
      }),
      'mapping.operations[0].notNeeded[0].evidence[0].kind',
    ],
    [
      'the document as evidence that a right is not needed',
      JSON.stringify({
        format: mappingFormat,
        rights: [],
        operations: [
          {
            operationId: 'getSyntheticThing',
            open: 'Offen.',
            notNeeded: [
              {
                right: { module: 'synthetic', name: 'view' },
                evidence: [{ kind: 'openapi' }],
              },
            ],
          },
        ],
      }),
      'mapping.operations[0].notNeeded[0].evidence[0].kind',
    ],
    [
      'a key twice, of which a review would read the first',
      `{"format": "${mappingFormat}", "rights": [], "operations": [{"operationId": "getSyntheticThing", "open": "Versteckt.", "open": "Offen."}]}`,
      'mapping.key[133]',
    ],
  ])('refuses %s and names its place', (_name, source, where) => {
    expect(placeOf(() => readMapping(source))).toBe(where);
  });
});

describe('applyMapping', () => {
  const read = (change: (mapping: Record<string, unknown>) => void) => {
    const mapping = syntheticMapping();
    change(mapping);
    return readMapping(JSON.stringify(mapping));
  };

  it.each([
    [
      'a right the facts do not hold',
      (mapping: Record<string, unknown>) => {
        const [right] = mapping['rights'] as { name: string }[];
        if (right !== undefined) {
          right.name = 'edit nothing';
        }
      },
      'mapping.rights[0]',
    ],
    [
      'an operation the facts do not hold',
      (mapping: Record<string, unknown>) => {
        const [entry] = mapping['operations'] as { operationId: string }[];
        if (entry !== undefined) {
          entry.operationId = 'aSyntheticThing';
        }
      },
      'mapping.operations[0].operationId',
    ],
    [
      'a label its page does not write before the name',
      (mapping: Record<string, unknown>) => {
        const rights = mapping['rights'] as { label?: { text: string } }[];
        const label = rights[3]?.label;
        if (label !== undefined) {
          label.text = 'Dinge bearbeiten';
        }
      },
      'mapping.rights[3].label',
    ],
    [
      'an explaining page the facts do not hold',
      (mapping: Record<string, unknown>) => {
        const [right] = mapping['rights'] as { pages: string[] }[];
        right?.pages.push('/de/help/synthetisch/fehlt/');
      },
      'mapping.rights[0].pages[1]',
    ],
  ])('stops at %s', (_name, change, where) => {
    expect(placeOf(() => applyMapping(read(change), facts()))).toBe(where);
  });

  it('stops at a right an entry both needs and does not need', () => {
    const mapping = syntheticMapping();
    const operations = mapping['operations'] as {
      notNeeded?: { right: { name: string } }[];
    }[];
    const right = operations[1]?.notNeeded?.[0]?.right;
    if (right !== undefined) {
      right.name = 'view things';
    }
    expect(
      placeOf(() =>
        applyMapping(readMapping(JSON.stringify(mapping)), facts()),
      ),
    ).toBe('mapping.operations[1].notNeeded[0].right');
  });

  it('keeps every right of the facts, mapped or not', () => {
    const applied = applyMapping(
      readMapping(
        JSON.stringify({ format: mappingFormat, rights: [], operations: [] }),
      ),
      facts(),
    );
    expect(applied.rights).toEqual(facts().rights);
    expect(applied.operationRights).toEqual([]);
  });
});
