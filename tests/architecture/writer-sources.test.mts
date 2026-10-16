import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The places that write with writeSync to fd 1 and fd 2 never name process
// or console: touching process.stdout or process.stderr makes the
// descriptor non-blocking, and so does loading node:process or node:util as
// a module, console writes free text, and closing fd 2 would end the log
// as well (ADR 0053, ADR 0054). Lint lifts some of these rules in a place for
// stdout or stderr, so this test reads the sources themselves. It looks
// at the syntax tree: identifiers, keys in brackets and module names, so
// that neither a comment nor a string such as 'https://' can hide a name.

const root = fileURLToPath(new URL('../../', import.meta.url));

const places = [
  'packages/cli/src/notices/',
  'packages/cli/src/output/',
  'packages/cli/src/send.ts',
  'packages/core/src/logger/',
];

const forbidden = new Set([
  'process',
  'console',
  'emitWarning',
  '_rawDebug',
  'close',
  'closeSync',
]);

// Modules whose ES module makes fd 1 or fd 2 non-blocking when it loads
// (ADR 0054); node:sys is the old name of node:util.
const forbiddenModules = new Set([
  'process',
  'node:process',
  'util',
  'node:util',
  'sys',
  'node:sys',
]);

/** The forbidden names and modules a source uses, in order. */
const namesIn = (code: string): string[] => {
  const file = ts.createSourceFile(
    'source.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      found.push(node.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      forbidden.has(node.argumentExpression.text)
    ) {
      found.push(node.argumentExpression.text);
    }
    const module =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (
      module !== undefined &&
      ts.isStringLiteralLike(module) &&
      forbiddenModules.has(module.text)
    ) {
      found.push(module.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

// Every source of a place, in subfolders too, as lint sees them. Only
// *.test.ts is left out: the build leaves out that form alone, so a file
// such as x.test.mts ships.
const sourcesOf = (base: string, place: string): string[] => {
  const path = join(base, place);
  if (!statSync(path).isDirectory()) return [place];
  return readdirSync(path, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.[cm]?ts$/.test(name) && !name.endsWith('.test.ts'))
    .map((name) => `${place}${name.split(sep).join('/')}`)
    .sort();
};

const sources = places.flatMap((place) => sourcesOf(root, place));

describe('the sources of the writers', () => {
  it('include every place', () => {
    for (const place of places) {
      expect(
        sources.some((source) => source.startsWith(place)),
        place,
      ).toBe(true);
    }
  });

  it('list the sources of a place in subfolders too, without its tests', () => {
    const base = mkdtempSync(join(tmpdir(), 'ecclium-writers-'));
    try {
      mkdirSync(join(base, 'place', 'deep'), { recursive: true });
      for (const name of [
        'a.ts',
        'deep/b.mts',
        'deep/c.cts',
        'a.test.ts',
        'deep/d.test.mts',
        'e.js',
      ]) {
        writeFileSync(join(base, 'place', name), 'export {};\n');
      }
      expect(sourcesOf(base, 'place/')).toEqual([
        'place/a.ts',
        'place/deep/b.mts',
        'place/deep/c.cts',
        'place/deep/d.test.mts',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each(sources)('never name process, console or a close in %s', (source) => {
    expect(namesIn(readFileSync(join(root, source), 'utf8'))).toEqual([]);
  });

  it.each([
    ["const url = 'https://'; process.stdout.write('x');", ['process']],
    ["const a = 'x'; /* a */ console.log(a);", ['console']],
    [
      'import { closeSync } from "node:fs";\ncloseSync(2);',
      ['closeSync', 'closeSync'],
    ],
    ['handle.close();', ['close']],
    ['const { stderr } = globalThis.process;', ['process']],
    ["import { stderr } from 'node:process';", ['node:process']],
    ["import { types } from 'node:util';", ['node:util']],
    ["export * from 'util';", ['util']],
    ["await import('node:sys');", ['node:sys']],
    ["import { stdout as out } from 'process';", ['process']],
    ["export { platform } from 'node:process';", ['node:process']],
    ["await import('node:process');", ['node:process']],
    ["fs['closeSync'](2);", ['closeSync']],
    ["globalThis['process'];", ['process']],
  ])('find the name in %j', (code, names) => {
    expect(namesIn(code)).toEqual(names);
  });

  it.each([
    '// process.stdout.write',
    "const text = 'process console close';",
    "import { writeSync } from 'node:fs';",
    "import { isProxy } from 'node:util/types';",
    'const closed = true;',
    '/** console */ export {};',
  ])('ignore %j', (code) => {
    expect(namesIn(code)).toEqual([]);
  });
});
