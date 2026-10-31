import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenVariableName } from '@ecclium/mcp-churchtools-core';
import { doubleOrigin, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import {
  auditFileText,
  emptyToolsetText,
  quotaFolderText,
  startText,
  toolsetsText,
  warningText,
} from '../messages/index.js';
import type { WriteSyncFn } from '../send.js';
import { startStdio, type StdioStartOptions } from './index.js';
import type { ServeOptions } from './serve.js';

// The first stage and the audit file (ADR 0028): it opens the file before
// the second stage loads, while fd 2 still blocks, and refuses a tool with
// sensitivity special, or one the catalog treats as such because it names
// persons (ADR 0064), without the folder. The second stage is a mock that
// records what it gets and what the folder held when it loaded.

const state = vi.hoisted(() => ({
  folder: '',
  atLoad: undefined as string[] | undefined,
  served: [] as ServeOptions[],
  serveThrows: false,
  special: false,
  names: false,
  noSongs: false,
}));

vi.mock(import('./serve.js'), async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // The moment the second stage loads: the file must be there already.
  try {
    state.atLoad = fs.readdirSync(path.join(state.folder, 'audit'));
  } catch {
    state.atLoad = [];
  }
  return {
    closeDeadlineMs: 5000,
    serve: (options: ServeOptions) => {
      state.served.push(options);
      if (state.serveThrows) throw new Error('serve');
      return undefined;
    },
  } as unknown as typeof import('./serve.js');
});

vi.mock(import('./catalog.js'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createStdioCatalog: (
      config: Parameters<typeof original.createStdioCatalog>[0],
    ) => {
      const catalog = original.createStdioCatalog(config);
      if (!state.special && !state.names && !state.noSongs) return catalog;
      // Every toolset brings tools of the core; a test takes those of the
      // songs out to see the notice of a toolset without tools.
      const kept = catalog
        .list()
        .filter((entry) => !state.noSongs || entry.meta.domain !== 'songs');
      // The start reads what the catalog derived, not the sensitivity.
      const added = state.special
        ? [
            {
              name: 'ct_test_special',
              meta: { sensitivity: 'special' },
              asSpecial: true,
            },
          ]
        : state.names
          ? [
              {
                name: 'ct_test_names',
                meta: { sensitivity: 'personal' },
                asSpecial: true,
              },
            ]
          : [];
      return { ...catalog, list: () => [...kept, ...added] } as never;
    },
  };
});

const base = mkdtempSync(join(tmpdir(), 'ecclium-start-audit-'));
let folders = 0;
const freshFolder = (): string => {
  folders += 1;
  const folder = join(base, `state-${String(folders)}`);
  rmSync(folder, { recursive: true, force: true });
  // mkdtemp gives 0700, the folder of state needs the same.
  const made = mkdtempSync(`${folder}-`);
  chmodSync(made, 0o700);
  return made;
};

afterEach(() => {
  for (const options of state.served) options.auditFile?.close();
  state.served.length = 0;
  state.serveThrows = false;
  state.special = false;
  state.names = false;
  state.noSongs = false;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const environment = (
  stateDir?: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
  [tokenVariableName]: makeCanary('token').value,
  ...(stateDir === undefined ? {} : { ECCLIUM_STATE_DIR: stateDir }),
  ...extra,
});

const decoder = new TextDecoder();

const start = async (
  stateDir: string | undefined,
  options: Omit<StdioStartOptions, 'writeSync'> = {},
  extra: Record<string, string> = {},
) => {
  const bytes: number[] = [];
  const writeSync: WriteSyncFn = (_fd, buffer, offset, length) => {
    for (const byte of buffer.subarray(offset, offset + length))
      bytes.push(byte);
    return length;
  };
  const code = await startStdio([], environment(stateDir, extra), [], {
    ...options,
    writeSync,
  });
  return { code, stderr: decoder.decode(new Uint8Array(bytes)) };
};

describe('the first stage and the audit file', () => {
  it('opens the file before the second stage loads and hands it over', async () => {
    const folder = freshFolder();
    state.folder = folder;
    const { code } = await start(folder);
    expect(code).toBeUndefined();
    expect(state.atLoad).toHaveLength(1);
    expect(state.atLoad?.[0]).toMatch(
      /^audit-\d{4}-\d{2}-\d{2}-\d{6}-\d+-1\.jsonl$/,
    );
    const [served] = state.served;
    expect(served?.auditFile?.ready()).toBe(true);
    expect(readdirSync(join(folder, 'audit'))).toEqual(state.atLoad);
  });

  it('hands over no file without the folder', async () => {
    const { code } = await start(undefined);
    expect(code).toBeUndefined();
    expect(state.served[0]?.auditFile).toBeUndefined();
  });

  it('refuses a tool with sensitivity special without the folder', async () => {
    state.special = true;
    const { code, stderr } = await start(undefined);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(startText('audit_file_required'));
    expect(state.served).toEqual([]);
  });

  it('refuses a tool that names persons without the folder', async () => {
    state.names = true;
    const { code, stderr } = await start(undefined);
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stderr).toContain(startText('audit_file_required'));
    expect(state.served).toEqual([]);
  });

  it('starts a tool with sensitivity special with the folder', async () => {
    state.special = true;
    const { code } = await start(freshFolder());
    expect(code).toBeUndefined();
    expect(state.served[0]?.auditFile).toBeDefined();
  });

  it('ends with its notice after the others and 78 when the file cannot be opened', async () => {
    const { code, stderr } = await start(freshFolder(), {
      openAuditFile: () => ({ ok: false, code: 'audit_file_unavailable' }),
    });
    expect(code).toBe(exitCodes.invalidConfig);
    const lines = stderr.split('\n').filter((line) => line !== '');
    expect(lines.at(-1)).toBe(auditFileText('audit_file_unavailable'));
    expect(lines.length).toBeGreaterThan(1);
    expect(state.served).toEqual([]);
  });

  // The folder of the read budget lies next to the audit file (ADR 0063).
  it('prepares the folder quota with 0700 before the second stage loads', async () => {
    const folder = freshFolder();
    const { code } = await start(folder);
    expect(code).toBeUndefined();
    expect(statSync(join(folder, 'quota')).mode & 0o777).toBe(0o700);
  });

  it('ends with its notice and 78, and closes the audit file, when the folder quota cannot be used', async () => {
    const closed: string[] = [];
    const { code, stderr } = await start(freshFolder(), {
      openAuditFile: () => ({
        ok: true,
        writer: {
          write: () => true,
          ready: () => true,
          attach: () => true,
          close: () => {
            closed.push('closed');
          },
          counts: () => ({
            written: 0,
            failed: 0,
            partial: 0,
            rejected: 0,
            reopened: 0,
            closed: false,
          }),
        },
      }),
      prepareQuotaFolder: () => ({ ok: false, code: 'quota_folder_unsafe' }),
    });
    expect(code).toBe(exitCodes.invalidConfig);
    const lines = stderr.split('\n').filter((line) => line !== '');
    expect(lines.at(-1)).toBe(quotaFolderText('quota_folder_unsafe'));
    expect(closed).toEqual(['closed']);
    expect(state.served).toEqual([]);
  });

  it('closes the open file when the second stage throws', async () => {
    state.serveThrows = true;
    const closed: string[] = [];
    const { code, stderr } = await start(freshFolder(), {
      openAuditFile: () => ({
        ok: true,
        writer: {
          write: () => true,
          ready: () => true,
          attach: () => true,
          close: () => {
            closed.push('closed');
          },
          counts: () => ({
            written: 0,
            failed: 0,
            partial: 0,
            rejected: 0,
            reopened: 0,
            closed: false,
          }),
        },
      }),
    });
    expect(code).toBe(exitCodes.internal);
    expect(stderr).toContain(startText('internal'));
    expect(closed).toEqual(['closed']);
  });
});

// The toolsets of the start (ADR 0062): the notices name those that are
// on, and each one that brings no tool, after the warnings.
describe('the first stage and the toolsets', () => {
  const lines = (stderr: string): string[] =>
    stderr.split('\n').filter((line) => line !== '');

  it('says nothing of toolsets when none is on', async () => {
    const { code, stderr } = await start(undefined);
    expect(code).toBeUndefined();
    expect(lines(stderr)).toEqual([warningText('token_from_environment')]);
  });

  it('names the toolsets that are on and each one without tools', async () => {
    state.noSongs = true;
    const { code, stderr } = await start(
      undefined,
      {},
      { ECCLIUM_TOOLSETS: 'songs,wiki' },
    );
    expect(code).toBeUndefined();
    expect(lines(stderr)).toEqual([
      warningText('token_from_environment'),
      toolsetsText(['wiki', 'songs']),
      emptyToolsetText('songs'),
    ]);
  });

  it('names the toolset persons, whose tools are in the catalog', async () => {
    const { code, stderr } = await start(
      freshFolder(),
      {},
      { ECCLIUM_TOOLSETS: 'persons' },
    );
    expect(code).toBeUndefined();
    expect(lines(stderr)).toEqual([
      warningText('token_from_environment'),
      warningText('persons_toolset_enabled'),
      toolsetsText(['persons']),
    ]);
  });

  it('names the toolsets also when the start stops for the folder', async () => {
    state.special = true;
    state.noSongs = true;
    const { code, stderr } = await start(
      undefined,
      {},
      { ECCLIUM_TOOLSETS: 'songs' },
    );
    expect(code).toBe(exitCodes.invalidConfig);
    expect(lines(stderr)).toEqual([
      warningText('token_from_environment'),
      toolsetsText(['songs']),
      emptyToolsetText('songs'),
      startText('audit_file_required'),
    ]);
  });
});
