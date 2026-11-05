import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileDayKeys,
  createFileKeyProvider,
  createFileSnapshotStore,
  createSnapshotKeeper,
  prepareDayKeyFolder,
  prepareSnapshotFolder,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type {
  IsoDate,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usageLine } from '../output/index.js';
import type { Output } from '../output/index.js';
import {
  changedLine,
  doneLines,
  undoChanged,
  undoMissing,
  undoProblems,
  undoUnchanged,
  wouldChangeLine,
} from './texts.js';
import { undoWrite } from './undo.js';

// The command against folders of state and keys on disk, with a snapshot
// sealed here as a write of the server keeps it, and the test double of
// ChurchTools in place of an instance (ADR 0031).

const canary = makeCanaries();
const guid = '00000000-0000-4000-8000-0000000000ab';
const pagePath = `/api/wiki/categories/12/pages/${guid}`;
const written = '11111111-2222-4333-8444-555555555555';
const before = '# Plan\nAlt\n';
const after = '# Plan\nNeu \u001b[31m\n';

let stateDir: string;
let keysDir: string;
// The key of the check codes and a policy that names whom to ask, which a
// server that writes to the wiki needs to start (ADR 0032).
let configDir: string;
const open: MockedHttpTransport[] = [];

const privateDir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return path;
};

beforeEach(() => {
  stateDir = privateDir('ecclium-undo-state-');
  keysDir = privateDir('ecclium-undo-keys-');
  configDir = privateDir('ecclium-undo-config-');
  writeFileSync(
    join(configDir, 'marker-key'),
    `${'0123456789abcdef'.repeat(4)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDir, 'policy.yaml'),
    'schema: policy.v1\ninteractive: { inquiriesTo: Sekretariat }\n',
    { mode: 0o600 },
  );
  // The folder of the kill switches, which the operator makes; without
  // it writing stays off.
  mkdirSync(join(stateDir, 'stop'), { mode: 0o700 });
});

afterEach(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

// The day of the write is today, so that its day key exists.
const today = (): IsoDate => new Date().toISOString().slice(0, 10) as IsoDate;

/** Keeps the snapshot of a write of the page from version 3 to 4. */
const keep = async (): Promise<void> => {
  prepareDayKeyFolder(keysDir, 'snapshot');
  prepareSnapshotFolder(stateDir);
  const keeper = createSnapshotKeeper({
    keys: createFileKeyProvider({
      dayKeys: createFileDayKeys({ keysDir, pid: process.pid }),
    }),
    store: createFileSnapshotStore({ stateDir, pid: process.pid }),
  });
  await keeper.save(
    { tenantId: 'default', instance: doubleOrigin } as unknown as TenantContext,
    {
      eventId: written,
      part: 'before',
      day: today(),
      content: {
        kind: 'wikiPageText',
        tool: 'ct_wiki_page_update',
        categoryId: 12,
        guid,
        before: { version: 3, text: before },
        after: { version: 4, textHash: hashOf(after) },
      },
    },
  );
};

// The hash a write keeps of its text, built as the core documents it in
// write/plan-hash.ts: after the tag of the encoding, each field as its
// length in bytes, a colon and its bytes.
const hashOf = (text: string): string => {
  const hash = createHash('sha256');
  for (const field of ['ecclium.content.v1', '1', text]) {
    const bytes = new TextEncoder().encode(field);
    hash.update(`${String(bytes.byteLength)}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

const reply = (version: number, text: string): string =>
  JSON.stringify({
    data: {
      title: 'Dienstplan',
      isMarkdown: true,
      version,
      text,
      wikiCategory: { id: 12 },
    },
  });

/** ChurchTools for an undo: the rights, the page now, and what it writes. */
const answer =
  (pages: readonly (readonly [number, string])[], writes = false) =>
  (double: MockedHttpTransport): void => {
    const json = {
      headers: {
        'content-type': 'application/json',
        date: new Date().toUTCString(),
      },
    };
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(
        200,
        JSON.stringify({ data: { churchwiki: { 'edit category': [12] } } }),
        json,
      );
    for (const [version, text] of pages) {
      double
        .intercept({ path: pagePath, method: 'GET' })
        .reply(200, reply(version, text), json);
    }
    if (writes) {
      double
        .intercept({ path: pagePath, method: 'PATCH' })
        .reply(200, '{}', json);
    }
  };

interface Run {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly transports: number;
}

const run = async (
  options: {
    readonly eventId?: string;
    readonly overwrite?: boolean;
    readonly environment?: Readonly<Record<string, string>>;
    readonly answer?: (double: MockedHttpTransport) => void;
  } = {},
): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let transports = 0;
  const output: Output = {
    stdout: (text) => {
      stdout.push(text);
      return true;
    },
    stderr: (text) => {
      stderr.push(text);
      return true;
    },
  };
  const createTransport = (settings: HttpTransportOptions): HttpTransport => {
    transports += 1;
    const double = createChurchToolsDouble({
      token: settings.token,
      origin: settings.origin,
      logger: settings.logger,
    });
    open.push(double);
    options.answer?.(double);
    return double.transport;
  };
  const code = await undoWrite({
    environment: options.environment ?? {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_KEYS_DIR: keysDir,
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_TOOLSETS: 'wiki',
      ECCLIUM_MARKER_KEY_FILE: join(configDir, 'marker-key'),
      ECCLIUM_POLICY_FILE: join(configDir, 'policy.yaml'),
    },
    execArgv: [],
    eventId: options.eventId ?? written,
    overwrite: options.overwrite ?? false,
    output,
    writeSync: (_fd, _buffer, _offset, length) => length,
    createTransport,
  });
  return { code, stdout, stderr, transports };
};

describe('ecclium undo', () => {
  it('takes a write back and shows the change, safe for the terminal', async () => {
    await keep();
    const result = await run({
      answer: answer(
        [
          [4, after],
          [4, after],
          [5, before],
        ],
        true,
      ),
    });
    expect(result.code).toBe(0);
    expect(result.stdout[0]).toBe(changedLine);
    // The escape of the page is shown, never sent to the terminal.
    expect(result.stdout.join('\n')).toContain('\\u{1b}[31m');
    expect(result.stdout.join('\n')).not.toContain('\u001b');
    const done = result.stdout.slice(-2);
    expect(done[0]).toBe(doneLines(5)[0]);
    expect(done[1]).toMatch(/^Auch diese Rücknahme lässt sich zurücknehmen/);
    expect(result.stderr).toEqual([]);
  });

  it('writes nothing over a page changed since and ends with 65', async () => {
    await keep();
    const result = await run({ answer: answer([[5, '# Von Hand\n']]) });
    expect(result.code).toBe(65);
    expect(result.stdout[0]).toBe(wouldChangeLine);
    expect(result.stderr).toEqual([undoChanged.text]);
  });

  it('finds no snapshot under an ID that kept none', async () => {
    await keep();
    const result = await run({
      eventId: '99999999-2222-4333-8444-555555555555',
    });
    expect(result.code).toBe(66);
    expect(result.stderr).toEqual([undoMissing.missing.text]);
  });

  it('checks the ID before it reads anything and never names it', async () => {
    const id = `NOT-AN-ID-${canary.token.value}`;
    const result = await run({ eventId: id, environment: {} });
    expect(result.code).toBe(64);
    expect(result.stderr).toEqual([undoProblems.id_invalid.text, usageLine]);
    expect(result.stderr.join('\n')).not.toContain(id);
    expect(result.transports).toBe(0);
  });

  it.each([
    [
      'while the server only reads',
      { ECCLIUM_READ_ONLY: 'true' },
      undoProblems.read_only,
    ],
    [
      'without snapshots',
      { ECCLIUM_SNAPSHOTS: 'off' },
      undoProblems.snapshots_off,
    ],
  ])('takes nothing back %s', async (_, change, ending) => {
    const result = await run({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
        ECCLIUM_STATE_DIR: stateDir,
        ECCLIUM_KEYS_DIR: keysDir,
        ECCLIUM_READ_ONLY: 'false',
        ...change,
      },
    });
    expect(result.code).toBe(ending.code);
    expect(result.stderr).toEqual([ending.text]);
    expect(result.transports).toBe(0);
  });

  it('ends with 78 for an invalid configuration', async () => {
    const result = await run({ environment: {} });
    expect(result.code).toBe(78);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('says nothing is left to do, and writes over a page changed since only with --overwrite', async () => {
    await keep();
    const unchanged = await run({ answer: answer([[5, before]]) });
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toEqual([undoUnchanged.text]);
    const overwritten = await run({
      overwrite: true,
      answer: answer(
        [
          [5, '# Von Hand\n'],
          [5, '# Von Hand\n'],
          [6, before],
        ],
        true,
      ),
    });
    expect(overwritten.code).toBe(0);
    expect(overwritten.stdout[0]).toBe(changedLine);
  });

  it('ends with 77 while writing is switched off or cannot be checked', async () => {
    await keep();
    writeFileSync(join(stateDir, 'stop', 'writes-off'), '');
    const off = await run({ answer: answer([[4, after]]) });
    expect(off.code).toBe(77);
    expect(off.stderr[0]).toMatch(/Kill-Switch/);
    rmSync(join(stateDir, 'stop'), { recursive: true });
    const unknown = await run({ answer: answer([[4, after]]) });
    expect(unknown.code).toBe(77);
    expect(unknown.stderr[0]).toMatch(/‹stop›/);
  });

  it('ends with 66 once the day key is gone', async () => {
    await keep();
    rmSync(join(keysDir, 'snapshot', `default.${today()}.key`));
    const result = await run();
    expect(result.code).toBe(66);
    expect(result.stderr).toEqual([undoMissing.expired.text]);
  });
});
