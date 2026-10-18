import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { loadBoundaries, workspaceRoot } from './boundaries.mts';
import {
  architectureDirectives,
  architectureLintConfig,
  architectureRuleIds,
  concernIds,
  liftingPlaces,
} from './lint-rules.mts';

// Proves each ESLint architecture restriction with code that breaks it, at
// every place of boundaries.json and next to it (ADR 0053, ADR 0022, ADR
// 0024, ADR 0051, ADR 0059). ESLint
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
  { code: "import { stdout } from 'node:process';", concerns: ['process'] },
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
  { code: "await import('node:tty');", concerns: ['stdout'] },
  {
    code: "import { writeFileSync } from 'node:fs';\nwriteFileSync(1, 'x');",
    concerns: ['stdout'],
  },
  {
    code: "import { createWriteStream } from 'node:fs';\ncreateWriteStream('/dev/stdout');",
    concerns: ['stdout'],
  },

  { code: "process.stderr.write('x');", concerns: ['stderr'] },
  { code: "process.emitWarning('x');", concerns: ['stderr'] },
  {
    code: "import { appendFileSync } from 'node:fs';\nappendFileSync(2, 'x');",
    concerns: ['stderr'],
  },
  {
    code: "import { writeFileSync } from 'node:fs';\nwriteFileSync('/dev/fd/2', 'x');",
    concerns: ['stderr'],
  },
  { code: "import { stderr } from 'process';", concerns: ['process'] },
  {
    code: "import { writeSync } from 'node:fs';\nwriteSync(2, 'x');",
    concerns: ['stderr'],
  },
  {
    code: "import { createWriteStream } from 'node:fs';\ncreateWriteStream('', { fd: 2 });",
    concerns: ['stderr'],
  },

  { code: 'const proc = process;', concerns: ['process'] },
  { code: 'const { env } = process;', concerns: ['environment', 'process'] },
  { code: "Reflect.get(process, 'stdout');", concerns: ['process'] },
  { code: "const key = 'stdout';\nprocess[key];", concerns: ['process'] },
  { code: 'globalThis.process.exitCode = 1;', concerns: ['process'] },
  { code: 'const root = globalThis;', concerns: ['process'] },
  { code: "import proc from 'node:process';", concerns: ['process'] },
  { code: "await import('node:process');", concerns: ['process'] },

  { code: "process.env['LANG'];", concerns: ['environment'] },
  { code: 'const home = process.env.HOME;', concerns: ['environment'] },
  { code: "process['env'];", concerns: ['environment'] },
  { code: 'delete process.env.X;', concerns: ['environment'] },
  { code: "import { env } from 'node:process';", concerns: ['process'] },
  {
    code: "import { env as variables } from 'process';",
    concerns: ['process'],
  },
  { code: 'const [, , first] = process.argv;', concerns: ['environment'] },
  { code: "process['argv'];", concerns: ['environment'] },
  { code: "import { argv } from 'node:process';", concerns: ['process'] },
  { code: 'process.report.getReport();', concerns: ['environment'] },
  { code: "import { report } from 'process';", concerns: ['process'] },
  {
    code: "import { parseArgs } from 'node:util';\nparseArgs({ options: {} });",
    concerns: ['environment', 'util-module'],
  },
  {
    code: "import { parseArgs } from 'node:util';\nparseArgs();",
    concerns: ['environment', 'util-module'],
  },
  {
    code: "import * as util from 'node:util';\nutil.parseArgs({ strict: true });",
    concerns: ['environment', 'util-module'],
  },
  {
    code: "import { parseArgs } from 'node:util';\nparseArgs({ args: [], options: {} });",
    concerns: ['util-module'],
  },

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
  { code: "import mod from 'node:module';", concerns: ['require'] },
  { code: "await import('module');", concerns: ['require'] },
  { code: "process.getBuiltinModule('node:fs');", concerns: ['require'] },
  { code: "eval('process.env');", concerns: ['require'] },
  { code: "(0, eval)('process.env');", concerns: ['require'] },
  { code: "globalThis.eval('process.env');", concerns: ['require'] },
  {
    code: "export const read = (): unknown => new Function('return process.env')();",
    concerns: ['require'],
  },
  { code: 'const Make = Function;', concerns: ['require'] },
  { code: "globalThis.Function('x');", concerns: ['require'] },
  {
    code: "import { getBuiltinModule } from 'node:process';",
    concerns: ['process'],
  },
  { code: "import { binding as b } from 'process';", concerns: ['process'] },
  { code: "import { execArgv } from 'node:process';", concerns: ['process'] },
  { code: "import { platform } from 'node:process';", concerns: ['process'] },
  { code: "export { platform } from 'node:process';", concerns: ['process'] },
  {
    code: "export type Process = typeof import('node:process');",
    concerns: ['process'],
  },

  { code: "import { types } from 'node:util';", concerns: ['util-module'] },
  { code: "import { types } from 'util';", concerns: ['util-module'] },
  { code: "import util from 'node:util';", concerns: ['util-module'] },
  { code: "import 'node:util';", concerns: ['util-module'] },
  { code: "import {} from 'node:util';", concerns: ['util-module'] },
  {
    code: "import { type InspectOptions } from 'node:util';",
    concerns: ['util-module'],
  },
  {
    code: "import type { InspectOptions } from 'node:util';",
    concerns: ['util-module'],
  },
  { code: "export { types } from 'node:util';", concerns: ['util-module'] },
  { code: "export * from 'util';", concerns: ['util-module'] },
  { code: "await import('node:util');", concerns: ['util-module'] },
  {
    code: "export type Util = typeof import('node:util');",
    concerns: ['util-module'],
  },
  { code: "import { parseArgs } from 'node:sys';", concerns: ['util-module'] },
  { code: "await import('sys');", concerns: ['util-module'] },

  {
    code: "import { subscribe } from 'node:diagnostics_channel';",
    concerns: ['diagnostics'],
  },
  {
    code: "import diagnostics from 'diagnostics_channel';",
    concerns: ['diagnostics'],
  },
  {
    code: "import type { Channel } from 'node:diagnostics_channel';",
    concerns: ['diagnostics'],
  },
  {
    code: "export * from 'node:diagnostics_channel';",
    concerns: ['diagnostics'],
  },
  {
    code: "await import('node:diagnostics_channel');",
    concerns: ['diagnostics'],
  },
  {
    code: "type Channels = typeof import('diagnostics_channel');",
    concerns: ['diagnostics'],
  },

  {
    code: "import { spawnSync } from 'node:child_process';",
    concerns: ['subprocess'],
  },
  {
    code: "import { Worker } from 'node:worker_threads';",
    concerns: ['subprocess'],
  },
  { code: "await import('node:cluster');", concerns: ['subprocess'] },

  {
    code: "server.registerTool('x', {}, () => ({}));",
    concerns: ['mcp-register'],
  },
  {
    code: "server['registerPrompt']('x', {}, () => ({}));",
    concerns: ['mcp-register'],
  },
  {
    code: 'mcp.server.setRequestHandler(schema, () => ({}));',
    concerns: ['mcp-register'],
  },
  {
    code: 'server.setNotificationHandler?.(schema, () => undefined);',
    concerns: ['mcp-register'],
  },
  {
    code: 'export const add = server.registerTool.bind(server);',
    concerns: ['mcp-register'],
  },
  {
    code: 'const { registerResource } = server;',
    concerns: ['mcp-register'],
  },
  {
    code: "const { 'registerTool': add } = server;",
    concerns: ['mcp-register'],
  },
  {
    code: "server[`registerTool`]('x', {}, () => ({}));",
    concerns: ['mcp-register'],
  },
  {
    code: 'server.fallbackRequestHandler = async () => ({});',
    concerns: ['mcp-register'],
  },
  {
    code: "mcp.server.removeRequestHandler('tools/call');",
    concerns: ['mcp-register'],
  },
  {
    code: "mcp.server.removeNotificationHandler('notifications/cancelled');",
    concerns: ['mcp-register'],
  },
  {
    code: 'mcp.server.registerCapabilities({ tools: {} });',
    concerns: ['mcp-register'],
  },
  {
    code: 'resource.readCallback = async () => ({ contents: [] });',
    concerns: ['mcp-register'],
  },

  {
    code: "import { fromJsonSchema } from '@modelcontextprotocol/server';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "export { fromJsonSchema as wrap } from '@modelcontextprotocol/server';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "import '@modelcontextprotocol/server/_shims';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "import { Ajv as Engine } from '@modelcontextprotocol/server/validators/ajv';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "export * from '@modelcontextprotocol/server/validators/cf-worker';",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "await import('@modelcontextprotocol/server/validators/ajv');",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "type Shims = typeof import('@modelcontextprotocol/server/_shims');",
    concerns: ['mcp-json-schema', 'mcp-sdk'],
  },
  {
    code: "export const schema = sdk.fromJsonSchema({ type: 'object' });",
    concerns: ['mcp-json-schema'],
  },
  {
    code: "await ctx.mcpReq.elicitInput({ message: 'x', requestedSchema });",
    concerns: ['mcp-json-schema'],
  },
  {
    code: "await server['elicitInput']({ message: 'x', requestedSchema });",
    concerns: ['mcp-json-schema'],
  },
  {
    code: "await server[`elicitInput`]({ message: 'x', requestedSchema });",
    concerns: ['mcp-json-schema'],
  },
  {
    code: 'const { elicitInput } = ctx.mcpReq;',
    concerns: ['mcp-json-schema'],
  },
  {
    code: "const { 'elicitInput': ask } = ctx.mcpReq;",
    concerns: ['mcp-json-schema'],
  },
  {
    code: 'export const ask = server.elicitInput.bind(server);',
    concerns: ['mcp-json-schema'],
  },
  {
    code: 'export const validator = new AjvJsonSchemaValidator();',
    concerns: ['mcp-json-schema', 'module-state'],
  },
  {
    code: 'export type Validator = DefaultJsonSchemaValidator;',
    concerns: ['mcp-json-schema'],
  },

  { code: 'let count = 0;', concerns: ['module-state'] },
  { code: 'export let count = 0;', concerns: ['module-state'] },
  { code: 'var count = 0;', concerns: ['module-state'] },
  { code: 'if (ready) {\n  var late = 1;\n}', concerns: ['module-state'] },
  {
    code: 'namespace Cache {\n  export let size = 0;\n}',
    concerns: ['module-state'],
  },
  { code: 'const cache = new Map();', concerns: ['module-state'] },
  { code: 'export const seen = new WeakMap();', concerns: ['module-state'] },
  { code: 'const table = { seen: new Set() };', concerns: ['module-state'] },
  { code: 'const refs = [new WeakRef(target)];', concerns: ['module-state'] },
  {
    code: 'export class Store {\n  static items = new Map();\n}',
    concerns: ['module-state'],
  },
  {
    code: 'export class Store {\n  static {\n    Store.seen = new WeakSet();\n  }\n}',
    concerns: ['module-state'],
  },
  {
    code: 'class Cache {\n  items = new Map<string, string>();\n}\nexport const cache = new Cache();',
    concerns: ['module-state'],
  },
  {
    code: 'export class Cache {\n  static readonly instance = new Cache();\n}',
    concerns: ['module-state'],
  },
  {
    code: 'export class Counter {\n  static count = 0;\n}',
    concerns: ['module-state'],
  },
  {
    code: 'export class Counter {\n  static accessor count = 0;\n}',
    concerns: ['module-state'],
  },
  {
    code: "import { AsyncLocalStorage } from 'node:async_hooks';\nexport const store = new AsyncLocalStorage();",
    concerns: ['module-state'],
  },
  {
    code: 'export const seen = new globalThis.Map();',
    concerns: ['module-state'],
  },
  {
    code: 'const Collection = Map;\nexport const items = new Collection();',
    concerns: ['module-state'],
  },

  { code: "await fetch('https://example.org');", concerns: ['network'] },
  { code: 'export const request = globalThis.fetch;', concerns: ['network'] },
  { code: "export const request = global['fetch'];", concerns: ['network'] },
  {
    code: "export const open = (): unknown => new WebSocket('wss://example.org');",
    concerns: ['network'],
  },
  {
    code: "export const open = (): unknown => new EventSource('https://example.org');",
    concerns: ['network'],
  },
  {
    code: 'export const open = (): unknown => new XMLHttpRequest();',
    concerns: ['network'],
  },
  { code: "import https from 'node:https';", concerns: ['network'] },
  { code: "import { connect } from 'net';", concerns: ['network'] },
  { code: "import type { Agent } from 'node:http';", concerns: ['network'] },
  { code: "export * from 'node:http2';", concerns: ['network'] },
  { code: "import { createSocket } from 'dgram';", concerns: ['network'] },
  { code: "await import('node:tls');", concerns: ['network'] },
  { code: "await import('node:dns/promises');", concerns: ['network'] },
  {
    code: "type Lookup = typeof import('node:dns');",
    concerns: ['network'],
  },
  { code: "import { request } from 'undici';", concerns: ['network'] },
  { code: "import type { Dispatcher } from 'undici';", concerns: ['network'] },
  { code: "await import('undici');", concerns: ['network'] },
  {
    code: "type Client = typeof import('undici/types/client');",
    concerns: ['network'],
  },
  { code: "import { open } from 'node:inspector';", concerns: ['network'] },
  {
    code: 'declare function fetch(url: string): Promise<unknown>;',
    concerns: ['network'],
  },
  {
    code: 'declare const WebSocket: new (url: string) => unknown;',
    concerns: ['network'],
  },
  { code: 'declare class EventSource {}', concerns: ['network'] },
  {
    code: 'declare const console: { log(text: string): void };',
    concerns: ['console'],
  },
];

/** Code that no restriction may touch. */
const allowed: readonly string[] = [
  'process.exitCode = 1;',
  "process.on('exit', () => undefined);",
  'const platform = process.platform;',
  "import { isProxy } from 'node:util/types';",
  "import { isMap } from 'util/types';",
  "await import('node:util/types');",
  'export const evaluate = { eval: (): void => undefined };',
  'export const kind = (value: unknown): string => typeof value;',
  "import { readFileSync } from 'node:fs';",
  "import { writeSync } from 'node:fs';\nwriteSync(3, 'x');",
  "await import('./local.js');",
  'const job = { process: (): void => undefined };\njob.process();',
  'const child = { stdout: 1 };\nexport const out = child.stdout;',
  'export class Worker {\n  process(): void {}\n}',
  "export const note = 'Messages go to /dev/stdout in the output module.';",
  "export const target = (): URL => new URL('https://example.org');",
  "registry.register('x');",
  'export function count(): number {\n  let n = 0;\n  n += 1;\n  return n;\n}',
  'export const make = (): Map<string, number> => new Map();',
  'export class Store {\n  readonly items = new Map<string, number>();\n}',
  'export class Store {\n  static readonly create = (): Set<string> => new Set();\n}',
  'export const limits = Object.freeze({ max: 100 });',
  'declare let ambient: number;',
  "declare module 'ecclium-example' {\n  let value: number;\n}",
  'export class Limits {\n  static readonly max = 100;\n}',
  'export class Store {\n  accessor items = new Map<string, number>();\n}',
  'export const encoder = new TextEncoder();',
  "export const percent = new Intl.NumberFormat('de-CH', { style: 'percent' });",
  'for (let index = 0; index < 3; index += 1) {\n  void index;\n}',
  'export class Tally {\n  count(): number {\n    let n = 0;\n    n += 1;\n    return n;\n  }\n}',
  'export const count = function (): number {\n  let n = 0;\n  n += 1;\n  return n;\n};',
  'export class Host {\n  addTool(): void {}\n}',
  'const fetch = (): void => undefined;\nfetch();',
  "import { readFile } from 'node:fs/promises';\nexport const read = readFile;",
  'export const options = (jsonSchemaValidator: object): object => ({ jsonSchemaValidator });',
  "export const name = 'fromJsonSchema';",
  'export const ask = { elicit: (): void => undefined };',
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
  {
    path: 'packages/core/src/probe.test.ts',
    allowed: ['mcp-json-schema', 'module-state', 'util-module'],
  },
  { path: 'packages/core/src/probe.test.mts', allowed: [] },
  { path: 'packages/core/src/probe.mts', allowed: [] },
  { path: 'packages/core/src/logger/probe.ts', allowed: ['stderr'] },
  { path: 'packages/core/src/loggerx/probe.ts', allowed: [] },
  { path: 'packages/cli/src/output/probe.ts', allowed: ['stdout', 'stderr'] },
  { path: 'packages/cli/src/outputx/probe.ts', allowed: [] },
  { path: 'packages/cli/src/stdio/probe.ts', allowed: [] },
  { path: 'packages/cli/src/notices/probe.ts', allowed: ['stderr'] },
  { path: 'packages/cli/src/noticesx/probe.ts', allowed: [] },
  { path: 'packages/cli/src/bin.ts', allowed: ['environment'] },
  { path: 'packages/cli/src/binary.ts', allowed: [] },
  { path: 'packages/cli/src/main.ts', allowed: ['util-module'] },
  {
    path: 'packages/cli/src/main.test.ts',
    allowed: ['mcp-json-schema', 'module-state', 'util-module'],
  },
  { path: 'packages/cli/src/mainline.ts', allowed: [] },
  { path: 'packages/testkit/src/canary.ts', allowed: ['util-module'] },
  { path: 'packages/testkit/src/canary-extra.ts', allowed: [] },
  {
    path: 'packages/core/src/logger/probe.test.ts',
    allowed: ['stderr', 'mcp-json-schema', 'module-state', 'util-module'],
  },
  {
    path: 'packages/cli/src/bin.test.ts',
    allowed: ['mcp-json-schema', 'module-state', 'util-module'],
  },
  { path: 'packages/core/src/mcp/probe.ts', allowed: ['mcp-sdk'] },
  {
    path: 'packages/core/src/mcp/mount.ts',
    allowed: ['mcp-sdk', 'mcp-register'],
  },
  { path: 'packages/core/src/mcp/mount-extra.ts', allowed: ['mcp-sdk'] },
  {
    path: 'packages/core/src/mcp/probe.test.ts',
    allowed: ['mcp-sdk', 'mcp-json-schema', 'module-state', 'util-module'],
  },
  { path: 'packages/core/src/mcpx/probe.ts', allowed: [] },
  { path: 'packages/server/src/probe.ts', allowed: ['mcp-sdk'] },
  { path: 'packages/server/src/stdio/probe.ts', allowed: ['mcp-sdk'] },
  { path: 'packages/core/src/http/probe.ts', allowed: ['network'] },
  { path: 'packages/core/src/httpx/probe.ts', allowed: [] },
  {
    path: 'packages/testkit/src/mcp-spike/server.ts',
    allowed: ['mcp-sdk', 'mcp-register'],
  },
  {
    path: 'packages/testkit/src/mcp-spike/stdio.ts',
    allowed: ['mcp-sdk', 'stderr'],
  },
  { path: 'packages/testkit/src/mcp-spike/log.ts', allowed: ['mcp-sdk'] },
  {
    path: 'packages/testkit/src/mcp-spike/probe.test.ts',
    allowed: ['mcp-sdk', 'mcp-json-schema', 'module-state', 'util-module'],
  },
  { path: 'packages/testkit/src/mcp-spikex/probe.ts', allowed: [] },
  { path: 'packages/testkit/src/probe.ts', allowed: [] },
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
    const lifting = liftingPlaces.flatMap((key) => places[key].paths);
    expect(lifting.length).toBeGreaterThan(0);
    for (const place of lifting) {
      expect(
        locations.some((location) => location.path.startsWith(place)),
        place,
      ).toBe(true);
    }
  });

  it('leave the files listed in moduleState to their own ADR', () => {
    const boundaries = loadBoundaries();
    const file = 'packages/core/src/index.ts';
    const blocks = architectureLintConfig({
      ...boundaries,
      places: {
        ...boundaries.places,
        moduleState: { ...boundaries.places.moduleState, paths: [file] },
      },
    });
    const block = blocks.find(
      (entry) => entry.name === 'architecture: module state',
    );
    expect(block?.ignores).toContain(file);
  });

  it.each([
    '// eslint-disable-next-line',
    '/* eslint-disable */',
    '// eslint-disable-line no-restricted-globals',
    '// eslint-disable-next-line no-console, no-restricted-syntax -- why',
    '/* eslint-disable ecclium-arch/no-module-state */',
    '/* eslint no-restricted-imports: off */',
  ])('find the directive %s', (comment) => {
    expect(architectureDirectives(`${comment}\nexport {};\n`)).toHaveLength(1);
  });

  it.each([
    '// eslint-disable-next-line @typescript-eslint/no-unused-vars -- why',
    '/* eslint-enable */',
    '// a comment about eslint-disable in prose',
    "export const note = 'eslint';",
  ])('let %s pass', (comment) => {
    expect(architectureDirectives(`${comment}\nexport {};\n`)).toEqual([]);
  });

  it('find no directive in the packages that switches off an architecture rule', () => {
    const root = join(workspaceRoot, 'packages');
    const files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readdirSync(join(root, entry.name, 'src'), { recursive: true })
          .map(String)
          .filter((file) => /\.[cm]?[jt]s$/.test(file))
          .map((file) => join(root, entry.name, 'src', file)),
      );
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) =>
      architectureDirectives(readFileSync(file, 'utf8')).map(
        (comment) => `${relative(workspaceRoot, file)}: ${comment}`,
      ),
    );
    expect(found).toEqual([]);
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
