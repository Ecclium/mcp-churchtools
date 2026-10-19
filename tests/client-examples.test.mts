import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

import {
  type ConfigResult,
  loadConfig,
  type TokenFileSystem,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { createStdioCatalog } from '../packages/cli/src/stdio/catalog.ts';

// docs/betrieb/stdio.md shows how two clients start the server over stdio,
// with one example file per client under docs/betrieb/beispiele/. This test
// keeps them usable as they are: the form the client reads, only the two
// variables that hold no secret and only placeholders in them, the
// executable that packages/cli/package.json names, a configuration that
// loads without a problem or a warning and gives exactly ct_whoami, and the
// line `claude mcp add-json` of the page in step with its example (ADR 0055).

/** A server as both clients list it under `mcpServers`. */
interface Server {
  readonly type?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** An example file: the servers by name. */
interface ClientConfig {
  readonly mcpServers: Readonly<Record<string, Server>>;
}

interface Manifest {
  readonly bin: Readonly<Record<string, string>>;
}

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const page = read('docs/betrieb/stdio.md');
const manifest = JSON.parse(read('packages/cli/package.json')) as Manifest;

// The placeholders of the page: the checkout, Node.js with its absolute
// path, because a client may start the server without the search path of
// the shell, and the token file with its absolute path written out,
// without ~ and without a variable.
const checkout = '/pfad/zum/checkout';
const node = '/pfad/zu/node';
const environment = {
  ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
  ECCLIUM_CHURCHTOOLS_TOKEN_FILE: '/pfad/zur/token-datei',
};
const placeholder = /^\/pfad\/zu[mr]?\/[a-z0-9._/-]+$/;

const examples = [
  {
    client: 'Claude Desktop',
    file: 'claude-desktop.json',
    keys: ['command', 'args', 'env'],
  },
  {
    client: 'Claude Code',
    file: 'claude-code.json',
    keys: ['type', 'command', 'args', 'env'],
  },
] as const;

/** Every string value in a parsed JSON value, keys left out. */
const stringsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(stringsOf);
};

/** One good token file in memory: the path in the example is a placeholder. */
const goodFile = (): TokenFileSystem => {
  const bytes = new TextEncoder().encode(`${makeCanary('token').value}\n`);
  const state = { position: 0 };
  return {
    openSync: () => {
      state.position = 0;
      return 3;
    },
    fstatSync: () => ({
      isFile: () => true,
      uid: 1000,
      mode: 0o100600,
      size: bytes.length,
    }),
    readSync: (_fd, buffer, offset, length) => {
      const chunk = bytes.subarray(state.position, state.position + length);
      buffer.set(chunk, offset);
      state.position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    getuid: () => 1000,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
  };
};

/** The configuration of an example, as the start over stdio loads it. */
const loadExample = (server: Server | undefined): ConfigResult =>
  loadConfig({
    environment: server?.env ?? {},
    transport: 'stdio',
    execArgv: [],
    tokenFiles: goodFile(),
  });

const parse = (file: string): { text: string; config: ClientConfig } => {
  const text = read(`docs/betrieb/beispiele/${file}`);
  return { text, config: JSON.parse(text) as ClientConfig };
};

describe.each(examples)('the example for $client', ({ file, keys }) => {
  const { text, config } = parse(file);
  const server = config.mcpServers['ecclium'];

  it('holds one server ecclium in the form the client reads', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(config)).toEqual(['mcpServers']);
    expect(Object.keys(config.mcpServers)).toEqual(['ecclium']);
    expect(Object.keys(server ?? {})).toEqual(keys);
  });

  it('sets only the address and the token file, both as placeholders', () => {
    expect(server?.env).toEqual(environment);
    expect(server?.command).toBe(node);
    for (const value of stringsOf(config)) {
      expect(
        value === 'stdio' ||
          value === environment.ECCLIUM_CHURCHTOOLS_URL ||
          (placeholder.test(value) && !value.includes('..')),
        value,
      ).toBe(true);
    }
  });

  it('starts the executable of packages/cli/package.json with stdio', () => {
    const bin = manifest.bin['ecclium'] ?? '';
    expect(bin).not.toBe('');
    expect(server?.args).toEqual([
      posix.join(checkout, 'packages/cli', bin),
      'stdio',
    ]);
  });

  it('loads without a problem or a warning, read-only and without search tools', () => {
    const result = loadExample(server);
    expect(result.report.problems).toEqual([]);
    expect(result.report.warnings).toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      config: { readOnly: true, searchTools: false },
    });
  });

  it('gives a catalog of exactly ct_whoami', () => {
    const result = loadExample(server);
    if (!result.ok) throw new Error('the example did not load');
    const catalog = createStdioCatalog(result.config);
    expect(catalog.list().map((entry) => entry.name)).toEqual(['ct_whoami']);
  });
});

describe('the page on the operation over stdio', () => {
  it('links the examples instead of copying them', () => {
    for (const { file } of examples) {
      expect(page).toContain(`](beispiele/${file})`);
    }
    expect(page).not.toContain('"mcpServers"');
  });

  // claude mcp add takes every word after --env as a variable up to --, the
  // name of the server included, so Claude Code 2.1.302 refused the short
  // form. The page passes the entry as JSON with claude mcp add-json.
  it('registers with claude mcp add-json exactly the server of the example for Claude Code', () => {
    const lines = page
      .split('\n')
      .filter((line) => line.startsWith('claude mcp add'));
    expect(lines).toHaveLength(1);
    const prefix = 'claude mcp add-json --scope user ';
    const line = lines[0] ?? '';
    expect(line.startsWith(prefix)).toBe(true);
    const rest = line.slice(prefix.length);
    const space = rest.indexOf(' ');
    const name = rest.slice(0, space);
    const quoted = rest.slice(space + 1);
    expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
    const entry = JSON.parse(quoted.slice(1, -1)) as Server;

    const { config } = parse('claude-code.json');
    expect(Object.keys(config.mcpServers)).toEqual([name]);
    expect(entry).toEqual(config.mcpServers[name]);
  });
});

describe('the root of the repository', () => {
  // A .mcp.json there would offer the server to everyone who starts the
  // client in the checkout, without a service account or a token file.
  it('has no .mcp.json', () => {
    expect(existsSync(new URL('../.mcp.json', import.meta.url))).toBe(false);
  });
});
