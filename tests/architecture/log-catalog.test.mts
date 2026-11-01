import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logEvents } from '@ecclium/mcp-churchtools-core';
import { afterAll, describe, expect, it } from 'vitest';

import { workspaceRoot } from './boundaries.mts';
import {
  type CatalogEntry,
  compareWithCatalog,
  packageSources,
  scanLogCalls,
} from './log-calls.mts';

// Every log line in the code of the packages stands in the catalog of the
// core with its level and its fields, and every entry has its line
// (ADR 0054). The logger also refuses a name outside the catalog when it
// runs; this test finds the line before it runs and keeps the catalog, and
// with it docs/log-events.md, true to the code. Building the program takes
// about a second.

const catalogFile = 'packages/core/src/logger/catalog.ts';

describe('the log lines of the packages', () => {
  const scan = scanLogCalls(
    workspaceRoot,
    packageSources(workspaceRoot),
    catalogFile,
  );

  it('each have an entry in the catalog, and each entry a line', () => {
    expect(compareWithCatalog(scan, logEvents)).toEqual([]);
  });

  it('are found in core, server and the command line', () => {
    // A scan that found nothing would pass the check above.
    expect(scan.calls.length).toBeGreaterThanOrEqual(80);
    const packages = new Set(scan.calls.map((call) => call.file.split('/')[1]));
    expect([...packages]).toEqual(
      expect.arrayContaining(['cli', 'core', 'server']),
    );
  });
});

// The counter-checks: small sources in a folder of their own, each with one
// mistake, against a catalog of two events.
describe('the check of the log lines', () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders)
      rmSync(folder, { recursive: true, force: true });
  });

  const catalog: Readonly<Record<string, CatalogEntry>> = {
    known_event: { level: 'info', fields: ['count'] },
  };

  const check = (
    body: string,
    entries: Readonly<Record<string, CatalogEntry>> = catalog,
  ): string[] => {
    const root = mkdtempSync(join(tmpdir(), 'ecclium-log-calls-'));
    folders.push(root);
    copyFileSync(
      join(workspaceRoot, 'tsconfig.base.json'),
      join(root, 'tsconfig.base.json'),
    );
    mkdirSync(join(root, 'packages', 'plugin-api', 'src'), { recursive: true });
    copyFileSync(
      join(workspaceRoot, 'packages', 'plugin-api', 'src', 'logger.ts'),
      join(root, 'packages', 'plugin-api', 'src', 'logger.ts'),
    );
    mkdirSync(join(root, 'packages', 'x', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'x', 'src', 'a.ts'),
      [
        "import type { Logger } from '../../plugin-api/src/logger.js';",
        'export function run(',
        '  log: Logger,',
        '  name: string,',
        "  level: 'info' | 'warn',",
        '  fields: Readonly<Record<string, number>>,',
        '): void {',
        "  log.info('known_event', { count: 1 });",
        body,
        '  void name;',
        '  void level;',
        '  void fields;',
        '}',
        '',
      ].join('\n'),
    );
    const scan = scanLogCalls(root, packageSources(root), 'none');
    return compareWithCatalog(scan, entries);
  };

  it('passes a source whose lines are all in the catalog', () => {
    expect(check("  const known = 'known_event';\n  log.info(known);")).toEqual(
      [],
    );
  });

  it.each([
    [
      'a name without an entry',
      "  log.info('unknown_event');",
      'packages/x/src/a.ts:9 writes unknown_event, which has no entry',
    ],
    [
      'another level',
      "  log.warn('known_event', { count: 2 });",
      'packages/x/src/a.ts:9 writes known_event at warn, the catalog says info',
    ],
    [
      'a field the entry does not name',
      "  log.info('known_event', { status: 200 });",
      'packages/x/src/a.ts:9 writes known_event with status, which its entry does not name',
    ],
    [
      'a name that is any string',
      '  log.info(name);',
      'packages/x/src/a.ts:9 has no fixed event name',
    ],
    [
      'a level from a variable',
      "  log[level]('known_event');",
      'packages/x/src/a.ts:9 has no fixed level',
    ],
    [
      'fields that are any record',
      "  log.info('known_event', fields);",
      'packages/x/src/a.ts:9 writes known_event with fields that are not fixed',
    ],
    [
      'a method taken from its logger',
      '  const warn = log.warn;\n  void warn;',
      'packages/x/src/a.ts:9 uses a method of a logger without calling it',
    ],
    [
      'a method taken apart from its logger',
      '  const { error } = log;\n  void error;',
      'packages/x/src/a.ts:9 uses a method of a logger without calling it',
    ],
    [
      'a call with optional chaining and any name',
      '  log?.info(name);',
      'packages/x/src/a.ts:9 has no fixed event name',
    ],
    [
      'a method called through call',
      "  log.info.call(log, 'unknown_event');",
      'packages/x/src/a.ts:9 uses a method of a logger without calling it',
    ],
    [
      'an element of a logger seen through Readonly',
      "  const frozen: Readonly<Logger> = log;\n  frozen['warn']('unknown_event');",
      'packages/x/src/a.ts:10 writes unknown_event, which has no entry',
    ],
  ])('reports %s', (_what, body, finding) => {
    expect(check(body)).toContain(finding);
  });

  it('reports an entry that no line writes', () => {
    expect(
      check('', { ...catalog, stale_event: { level: 'warn', fields: [] } }),
    ).toEqual(['stale_event has an entry, but no call writes it']);
  });

  it('reports an entry whose name no code writes out', () => {
    expect(
      check(
        "  const built = `known_${name === '' ? 'a' : 'b'}` as `known_${'a' | 'b'}`;\n  log.info(built);",
        {
          ...catalog,
          known_a: { level: 'info', fields: [] },
          known_b: { level: 'info', fields: [] },
        },
      ),
    ).toEqual([
      'known_a has an entry, but no code names it',
      'known_b has an entry, but no code names it',
    ]);
  });
});
