import { join } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';
import { architectureRuleIds, concernIds } from './lint-rules.mts';

// Proves each ESLint architecture restriction with code that breaks it, at
// every place of boundaries.json and next to it (ADR 0018, ADR 0024). ESLint
// finds its configuration from the workspace root, as `pnpm lint` does, but
// runs without type information: the project service refuses paths that do
// not exist on disk. Only the architecture rules are reported.

type Concern = (typeof concernIds)[number];

const eslint = new ESLint({
  cwd: workspaceRoot,
  overrideConfig: tseslint.configs.disableTypeChecked,
  ruleFilter: ({ ruleId }) => architectureRuleIds.includes(ruleId),
});

/** Messages of the architecture rules for code at the given path. */
async function lint(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(workspaceRoot, path),
  });
  if (result === undefined) throw new Error(`no result for ${path}`);
  // A parse error has no rule id and would let every check pass.
  if (result.fatalErrorCount > 0) {
    throw new Error(`${path}: ${result.messages[0]?.message ?? ''}`);
  }
  return result.messages.map((message) => message.message);
}

/**
 * Ids of the restrictions that the code breaks at the given path. Some rules
 * put their own sentence before the configured message, so the id may stand
 * anywhere in it.
 */
async function concerns(code: string, path: string): Promise<string[]> {
  const ids = (await lint(code, path)).map(
    (message) => /\[arch:([a-z-]+)\]/.exec(message)?.[1] ?? message,
  );
  return [...new Set(ids)].sort();
}

/** Code that breaks exactly the listed restrictions anywhere in a package. */
const probes: readonly {
  readonly code: string;
  readonly concerns: readonly Concern[];
}[] = [
  { code: "console.log('x');", concerns: ['console'] },
  { code: 'const log = console.log;', concerns: ['console'] },
  { code: 'const { log } = console;', concerns: ['console'] },
  { code: "globalThis.console.log('x');", concerns: ['console'] },
  { code: "import { log } from 'node:console';", concerns: ['console'] },
  { code: "import out from 'console';", concerns: ['console'] },
  { code: "await import('node:console');", concerns: ['console'] },

  { code: "process.stdout.write('x');", concerns: ['stdout'] },
  { code: "process['stdout'].write('x');", concerns: ['stdout'] },
  { code: "import { stdout } from 'node:process';", concerns: ['stdout'] },
  {
    code: "import { writeSync } from 'node:fs';\nwriteSync(1, 'x');",
    concerns: ['stdout'],
  },
  {
    code: "import fs from 'node:fs';\nfs.writeSync(1, 'x');",
    concerns: ['stdout'],
  },
  {
    code: "import { createWriteStream } from 'node:fs';\ncreateWriteStream('', { fd: 1 });",
    concerns: ['stdout'],
  },
  { code: "import { WriteStream } from 'node:tty';", concerns: ['stdout'] },

  { code: "process.stderr.write('x');", concerns: ['stderr'] },
  { code: "import { stderr } from 'process';", concerns: ['stderr'] },
  {
    code: "import { writeSync } from 'node:fs';\nwriteSync(2, 'x');",
    concerns: ['stderr'],
  },
  {
    code: "import { createWriteStream } from 'node:fs';\ncreateWriteStream('', { fd: 2 });",
    concerns: ['stderr'],
  },

  { code: 'const proc = process;', concerns: ['process'] },
  { code: 'const { env } = process;', concerns: ['process'] },
  { code: "Reflect.get(process, 'stdout');", concerns: ['process'] },
  { code: "const key = 'stdout';\nprocess[key];", concerns: ['process'] },
  { code: 'globalThis.process.exitCode = 1;', concerns: ['process'] },
  { code: "import proc from 'node:process';", concerns: ['process'] },
  { code: "await import('node:process');", concerns: ['process'] },

  {
    code: "import { McpServer } from '@modelcontextprotocol/server';",
    concerns: ['mcp-sdk'],
  },
  {
    code: "import type { Tool } from '@modelcontextprotocol/server';",
    concerns: ['mcp-sdk'],
  },
  {
    code: "export * from '@modelcontextprotocol/hono';",
    concerns: ['mcp-sdk'],
  },
  {
    code: "await import('@modelcontextprotocol/server');",
    concerns: ['mcp-sdk'],
  },
  {
    code: "type Server = typeof import('@modelcontextprotocol/server');",
    concerns: ['mcp-sdk'],
  },

  {
    code: "const file = './local.js';\nawait import(file);",
    concerns: ['dynamic-import'],
  },

  {
    code: "import { createRequire } from 'node:module';",
    concerns: ['require'],
  },
];

/** Code that no restriction may touch. */
const allowed: readonly string[] = [
  "process.env['LANG'];",
  'process.exitCode = 1;',
  "process.on('exit', () => undefined);",
  "import { env } from 'node:process';",
  "import { readFileSync } from 'node:fs';",
  "import { writeSync } from 'node:fs';\nwriteSync(3, 'x');",
  "await import('./local.js');",
  'const job = { process: (): void => undefined };\njob.process();',
  'const child = { stdout: 1 };\nexport const out = child.stdout;',
  'export class Worker {\n  process(): void {}\n}',
];

/**
 * Where the probes run and what may happen there. Written out by hand, so
 * that the test does not repeat the logic of the generator it checks.
 */
const locations: readonly {
  readonly path: string;
  readonly allowed: readonly Concern[];
}[] = [
  { path: 'packages/core/src/probe.ts', allowed: [] },
  { path: 'packages/core/src/probe.test.ts', allowed: [] },
  { path: 'packages/core/src/probe.mts', allowed: [] },
  { path: 'packages/core/src/logger/probe.ts', allowed: ['stderr'] },
  { path: 'packages/core/src/loggerx/probe.ts', allowed: [] },
  { path: 'packages/cli/src/output/probe.ts', allowed: ['stdout', 'stderr'] },
  { path: 'packages/cli/src/outputx/probe.ts', allowed: [] },
  { path: 'packages/cli/src/stdio/probe.ts', allowed: [] },
  { path: 'packages/core/src/mcp/probe.ts', allowed: ['mcp-sdk'] },
  { path: 'packages/core/src/mcpx/probe.ts', allowed: [] },
  { path: 'packages/server/src/probe.ts', allowed: ['mcp-sdk'] },
  { path: 'packages/server/src/stdio/probe.ts', allowed: ['mcp-sdk'] },
];

describe('ESLint architecture rules', () => {
  it.each(locations)(
    'restrict $path to what it may do',
    async ({ path, allowed: lifted }) => {
      const found = await Promise.all(
        probes.map(async (probe) => [
          probe.code,
          await concerns(probe.code, path),
        ]),
      );
      const expected = probes.map((probe) => [
        probe.code,
        probe.concerns.filter((concern) => !lifted.includes(concern)),
      ]);
      expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected));
    },
  );

  it.each(allowed)('allow %s', async (code) => {
    expect(await concerns(code, 'packages/core/src/probe.ts')).toEqual([]);
  });

  it.each(['scripts/probe.mts', 'tests/probe.test.mts'])(
    'leave %s alone',
    async (path) => {
      const found = await Promise.all(
        probes.map((probe) => concerns(probe.code, path)),
      );
      expect(found.flat()).toEqual([]);
    },
  );

  it('cover every place of boundaries.json that lifts a restriction', () => {
    const { places } = loadBoundaries();
    const lifting = [
      ...places.stdout.paths,
      ...places.stderr.paths,
      ...places.mcpSdk.paths,
    ];
    for (const place of lifting) {
      expect(
        locations.some((location) => location.path.startsWith(place)),
        place,
      ).toBe(true);
    }
  });

  it('have a failing example for every restriction', () => {
    const proven = new Set(probes.flatMap((probe) => probe.concerns));
    expect(proven).toEqual(new Set(concernIds));
  });

  it('name an ADR in every message', async () => {
    const messages = (
      await Promise.all(
        probes.map((probe) => lint(probe.code, 'packages/core/src/probe.ts')),
      )
    ).flat();
    expect(messages.length).toBeGreaterThanOrEqual(probes.length);
    for (const message of messages) {
      expect(message).toMatch(/\[arch:[a-z-]+\] .*\(ADR \d{4}\)\.$/);
    }
  });
});
