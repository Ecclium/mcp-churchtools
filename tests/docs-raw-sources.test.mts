import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  looksLikeHtmlPage,
  looksLikeOpenApiDocument,
} from '@ecclium/mcp-churchtools-docs-index';
import { afterAll, describe, expect, it } from 'vitest';

// No raw source of the docs index in the tree (ADR 0027, ADR 0066): no
// OpenAPI document anywhere and no HTML page outside brand/, the brand
// package with HTML templates of its own. The files are those Git lists,
// tracked or new and not ignored, so a file is caught before its commit.

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

interface RawSource {
  readonly file: string;
  readonly kind: 'html' | 'openapi';
}

function treeFiles(root: string): readonly string[] {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((file) => file !== '');
}

function rawSourcesIn(root: string): readonly RawSource[] {
  const found: RawSource[] = [];
  for (const file of treeFiles(root)) {
    if (file.startsWith('brand/')) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      // Listed but gone, such as a file deleted and not yet committed.
      continue;
    }
    if (/\.html?$/i.test(file) || looksLikeHtmlPage(text)) {
      found.push({ file, kind: 'html' });
    }
    if (looksLikeOpenApiDocument(text)) {
      found.push({ file, kind: 'openapi' });
    }
  }
  return found;
}

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function repository(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'ecclium-raw-sources-'));
  folders.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe('the tree of the repository', () => {
  it('holds no OpenAPI document and no HTML page outside brand/', () => {
    expect(rawSourcesIn(workspaceRoot)).toEqual([]);
  });
});

describe('the search for raw sources', () => {
  it('finds a planted document and page and leaves the rest alone', () => {
    const root = repository({
      // Built at run time, so that this file does not look like a
      // document itself.
      'packages/docs-index/data/openapi.json': JSON.stringify({
        openapi: '3.1.0',
        info: {},
        paths: {},
      }),
      'scripts/spec.yaml': 'openapi: 3.1.0\npaths: {}\n',
      'packages/docs-index/data/page.txt': '<!DOCTYPE html><html></html>',
      'docs/page.htm': 'Text',
      'brand/src/social/card.html': '<!doctype html><html></html>',
      'tests/fixture.ts': "const page = '<html><body></body></html>';\n",
      'ignored/page.html': '<!doctype html>',
      '.gitignore': 'ignored/\n',
    });
    expect(rawSourcesIn(root)).toEqual([
      { file: 'docs/page.htm', kind: 'html' },
      { file: 'packages/docs-index/data/openapi.json', kind: 'openapi' },
      { file: 'packages/docs-index/data/page.txt', kind: 'html' },
      { file: 'scripts/spec.yaml', kind: 'openapi' },
    ]);
  });
});
