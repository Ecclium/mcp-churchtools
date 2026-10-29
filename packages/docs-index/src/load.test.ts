import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { syntheticFactFiles } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  docsIndexFileName,
  DocsIndexError,
  maxDocsIndexBytes,
} from './artifact.js';
import {
  defaultBuildLocations,
  readFactFiles,
  writeDocsIndex,
} from './build/files.js';
import { DocsFactsError, type FactFileTexts } from './facts.js';
import { defaultDocsIndexFile, readDocsIndex } from './load.js';

// Writing and reading the built file (ADR 0066), in a folder of its own
// for each test.

const folders: string[] = [];

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'ecclium-docs-index-'));
  folders.push(path);
  return path;
}

function dataFolder(texts: FactFileTexts): URL {
  const path = folder();
  for (const [name, text] of Object.entries(texts)) {
    writeFileSync(join(path, name), text);
  }
  return pathToFileURL(`${path}/`);
}

afterEach(() => {
  for (const path of folders.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('writeDocsIndex and readDocsIndex', () => {
  it('write the built file and read it back', () => {
    const outFile = pathToFileURL(join(folder(), 'out', docsIndexFileName));
    const bytes = writeDocsIndex({
      dataDir: dataFolder(syntheticFactFiles()),
      outFile,
    });
    expect(bytes).toBeGreaterThan(0);
    const index = readDocsIndex(outFile);
    expect(index.getOperation('getSyntheticThing')?.fact.method).toBe('get');
  });

  it('write nothing when a fact breaks a rule', () => {
    const out = folder();
    const texts = { ...syntheticFactFiles(), 'academy.json': '{}' };
    expect(() =>
      writeDocsIndex({
        dataDir: dataFolder(texts),
        outFile: pathToFileURL(join(out, docsIndexFileName)),
      }),
    ).toThrow(DocsFactsError);
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuse a missing file without naming its path', () => {
    const path = join(folder(), 'missing-folder-name', docsIndexFileName);
    let caught: unknown;
    try {
      readDocsIndex(pathToFileURL(path));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocsIndexError);
    expect((caught as DocsIndexError).problem).toBe('missing');
    expect((caught as DocsIndexError).message).not.toContain(
      'missing-folder-name',
    );
  });

  it('refuse a file over the limit before reading it', () => {
    const path = join(folder(), docsIndexFileName);
    writeFileSync(path, ' '.repeat(maxDocsIndexBytes + 1));
    expect(() => readDocsIndex(pathToFileURL(path))).toThrow(
      expect.objectContaining({ problem: 'size' }),
    );
  });
});

describe('the default locations', () => {
  it('read the folder data/ of the package and write into its dist/', () => {
    const { dataDir, outFile } = defaultBuildLocations();
    expect(dataDir.href).toMatch(/\/packages\/docs-index\/data\/$/);
    expect(outFile.href).toMatch(
      /\/packages\/docs-index\/dist\/docs-index\.json$/,
    );
    expect(defaultDocsIndexFile().href).toBe(outFile.href);
    expect(existsSync(new URL('SOURCES.json', dataDir))).toBe(true);
    expect(Object.keys(readFactFiles(dataDir))).toHaveLength(4);
  });
});
