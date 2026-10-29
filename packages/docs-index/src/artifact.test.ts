import {
  syntheticFactFiles,
  syntheticFacts,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDocsIndex,
  docsIndexFormat,
  searchFields,
  DocsIndexError,
  type DocsIndexProblem,
  maxDocsIndexBytes,
  parseDocsIndex,
} from './artifact.js';
import { defaultBuildLocations, readFactFiles } from './build/files.js';
import { canonicalJson, DocsFactsError, type Facts } from './facts.js';

// The built docs index (ADR 0066): built from the facts, the same bytes
// every time, and checked as strictly on load as on build.

type Json = Record<string, unknown>;

function problemOf(run: () => unknown): DocsIndexProblem | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof DocsIndexError) {
      return error.problem;
    }
    throw error;
  }
  return undefined;
}

function tampered(change: (artifact: Json) => void): string {
  const artifact = JSON.parse(buildDocsIndex(syntheticFactFiles())) as Json;
  change(artifact);
  return JSON.stringify(artifact);
}

function searchOf(artifact: Json, source: string): Json {
  return (artifact['search'] as Json)[source] as Json;
}

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') {
    return [value];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(numbersIn);
  }
  return [];
}

describe('buildDocsIndex', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('builds the facts under data/', () => {
    const text = buildDocsIndex(readFactFiles(defaultBuildLocations().dataDir));
    const { facts, search } = parseDocsIndex(text);
    expect(facts.sources.format).toBe('ecclium.docs.sources.v1');
    expect(search.operations.keys).toEqual(
      facts.operations.entries.map(({ operationId }) => operationId),
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxDocsIndexBytes);
  });

  it('keeps the facts and indexes every source', () => {
    const { facts, search } = parseDocsIndex(
      buildDocsIndex(syntheticFactFiles()),
    );
    expect(facts).toEqual(syntheticFacts());
    expect(search.operations.keys).toHaveLength(5);
    expect(search.rights.keys).toHaveLength(4);
    expect(search.academy.keys).toEqual([
      '/de/help/synthetisch/dinge-rechte/',
      '/de/help/synthetisch/dinge-verwalten/',
    ]);
    expect(search.academy.terms).toContain('gruppenmitglieder');
  });

  it('gives the same bytes at another time and in another time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    const first = buildDocsIndex(syntheticFactFiles());
    vi.setSystemTime(new Date('2001-06-30T23:59:59Z'));
    vi.stubEnv('TZ', 'America/Adak');
    expect(buildDocsIndex(syntheticFactFiles())).toBe(first);
  });

  it('freezes the fields of the search down to each field', () => {
    expect(Object.isFrozen(searchFields.rights[0])).toBe(true);
  });

  it('holds no number with a fraction', () => {
    const artifact = JSON.parse(buildDocsIndex(syntheticFactFiles())) as Json;
    expect(numbersIn(artifact).every(Number.isInteger)).toBe(true);
    expect(artifact['format']).toBe(docsIndexFormat);
  });

  it('refuses facts that break a rule', () => {
    const texts = { ...syntheticFactFiles(), 'rights.json': '{' };
    expect(() => buildDocsIndex(texts)).toThrow(DocsFactsError);
  });

  it(`refuses a built file over ${String(maxDocsIndexBytes)} bytes`, () => {
    // Many different words make a large search index from facts that stay
    // under the limits of their files.
    const facts = syntheticFacts() as Facts & {
      operations: { entries: Facts['operations']['entries'][number][] };
    };
    const template = facts.operations.entries[1];
    const entries = Array.from({ length: 110 }, (_v, at) => ({
      ...template,
      operationId: `op${String(at).padStart(3, '0')}`,
      description: Array.from(
        { length: 2_600 },
        (_w, word) => `w${(at * 2_600 + word).toString(36)}`,
      ).join(' '),
    }));
    const texts = syntheticFactFiles({
      ...facts,
      operations: { ...facts.operations, entries },
    } as Facts);
    expect(problemOf(() => buildDocsIndex(texts))).toBe('size');
  });
});

describe('parseDocsIndex', () => {
  it(`refuses a file over ${String(maxDocsIndexBytes)} bytes`, () => {
    expect(
      problemOf(() => parseDocsIndex(' '.repeat(maxDocsIndexBytes + 1))),
    ).toBe('size');
  });

  it.each<[string, () => string, DocsIndexProblem]>([
    ['text that is not JSON', () => '{', 'json'],
    [
      'another format',
      () =>
        tampered((artifact) => {
          artifact['format'] = 'ecclium.docs-index.v2';
        }),
      'format',
    ],
    [
      'an unknown field',
      () =>
        tampered((artifact) => {
          artifact['extra'] = 1;
        }),
      'format',
    ],
    [
      'a broken fact',
      () =>
        tampered((artifact) => {
          (artifact['rights'] as Json)['entries'] = 'none';
        }),
      'facts',
    ],
    [
      'a search without a key',
      () =>
        tampered((artifact) => {
          (searchOf(artifact, 'operations')['keys'] as string[]).pop();
        }),
      'search',
    ],
    [
      'a search over another document',
      () =>
        tampered((artifact) => {
          const keys = searchOf(artifact, 'operations')['keys'] as string[];
          keys[keys.length - 1] = 'zzzOtherOperation';
        }),
      'search',
    ],
    [
      'a word the search could never reach',
      () =>
        tampered((artifact) => {
          const terms = searchOf(artifact, 'academy')['terms'] as string[];
          terms[0] = terms[0]?.toUpperCase() ?? '';
        }),
      'search',
    ],
    [
      'a posting outside the documents',
      () =>
        tampered((artifact) => {
          const postings = searchOf(artifact, 'rights')[
            'postings'
          ] as number[][];
          postings[0] = [99, 0, 1];
        }),
      'search',
    ],
    [
      'a value nested too deep',
      () =>
        tampered((artifact) => {
          artifact['sources'] = 'deep';
        }).replace(
          '"sources":"deep"',
          `"sources":${'['.repeat(100_000)}${']'.repeat(100_000)}`,
        ),
      'format',
    ],
    [
      'other weights',
      () =>
        tampered((artifact) => {
          searchOf(artifact, 'rights')['weights'] = [1, 1, 1];
        }),
      'search',
    ],
    [
      'a host in a word of the search',
      () =>
        tampered((artifact) => {
          (searchOf(artifact, 'academy')['terms'] as string[]).push(
            'www.vendor.example',
          );
        }),
      'host',
    ],
    [
      'markup in a word of the search',
      () =>
        tampered((artifact) => {
          (searchOf(artifact, 'academy')['terms'] as string[]).push('<b>');
        }),
      'html',
    ],
    [
      'a key that is not part of the format',
      () =>
        tampered((artifact) => {
          (artifact['operations'] as Json)['www.vendor.example'] = 1;
        }),
      'facts',
    ],
  ])('refuses %s', (_name, text, problem) => {
    expect(problemOf(() => parseDocsIndex(text()))).toBe(problem);
  });

  it('names no key from the file in a finding', () => {
    const text = tampered((artifact) => {
      (searchOf(artifact, 'academy')['terms'] as string[]).push(
        'www.vendor.example',
      );
      (artifact['operations'] as Json)['gemeinde_zuerich'] = 1;
    });
    let caught: unknown;
    try {
      parseDocsIndex(text);
    } catch (error) {
      caught = error;
    }
    expect((caught as DocsIndexError).problem).toBe('facts');
    expect(String(caught)).not.toContain('gemeinde_zuerich');
  });

  it('keeps the findings of a broken fact as its cause, without values', () => {
    const sentinel = 'sentinel-7f3a';
    const text = tampered((artifact) => {
      (artifact['academy'] as Json)['notice'] = `${sentinel}\u0000`;
    });
    let caught: unknown;
    try {
      parseDocsIndex(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocsIndexError);
    const error = caught as DocsIndexError;
    expect(error.cause).toBeInstanceOf(DocsFactsError);
    expect(`${error.message} ${String(error.cause)}`).not.toContain(sentinel);
  });

  it('reads back the canonical facts it was built from', () => {
    const texts = syntheticFactFiles();
    const { facts } = parseDocsIndex(buildDocsIndex(texts));
    expect(canonicalJson(facts.operations)).toBe(texts['operations.json']);
  });
});
