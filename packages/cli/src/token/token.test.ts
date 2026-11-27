import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bearerTokenFormProblem,
  type BearerTokenEntry,
  type ConfigFileSystem,
  createBearerToken,
  hashBearerToken,
  readBearerTokensFile,
  serializeBearerTokens,
} from '@ecclium/mcp-churchtools-core';
import {
  createFileQuotaStore,
  prepareQuotaFolder,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  bearerLastUseKey,
  type IsoDate,
  type TenantId,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createMemoryQuotaStore } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import type { Output } from '../output/index.js';
import { tokenTexts } from './texts.js';
import { runToken, type TokenOptions } from './token.js';
import { nodeWriterFileSystem, type WriterFileSystem } from './write.js';

// No token stands in this file as a literal: the rule of .gitleaks.toml
// would find it. Every token comes into being at run time.

const root = mkdtempSync(join(tmpdir(), 'ecclium-token-command-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// The file functions of Node.js for the reader, to replace one of them.
const nodeConfigFiles: ConfigFileSystem = {
  openSync: (target, flags) => openSync(target, flags),
  fstatSync: (fd) => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => {
    closeSync(fd);
  },
  getuid: () => process.getuid?.(),
  constants,
};

// The mode of a file, read through one descriptor: a check by path before
// a use by path is a race that CodeQL reports (js/file-system-race).
const modeOf = (target: string): number => {
  const fd = openSync(target, constants.O_RDONLY);
  try {
    return fstatSync(fd).mode & 0o777;
  } finally {
    closeSync(fd);
  }
};

// A fixed instant of the clock, so that no test depends on the calendar.
const now = Date.UTC(2026, 10, 26, 12, 0, 0);
const clock = { now: () => now };
const today = '2026-11-26';

let counter = 0;
let folder = '';
let path = '';
beforeEach(() => {
  counter += 1;
  folder = join(root, `case-${String(counter)}`);
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(folder, 0o700);
  path = join(folder, 'http-tokens.yaml');
});

interface Captured {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const capture = async (
  options: Partial<TokenOptions> & Pick<TokenOptions, 'action'>,
  stdoutWorks = true,
): Promise<Captured> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: Output = {
    stdout: (text) => {
      if (!stdoutWorks) return false;
      stdout.push(text);
      return true;
    },
    stderr: (text) => {
      stderr.push(text);
      return true;
    },
  };
  const code = await runToken({
    environment: { ECCLIUM_HTTP_TOKENS_FILE: path },
    clock,
    output,
    ...options,
  });
  return { code, stdout, stderr };
};

const entriesOf = (): readonly BearerTokenEntry[] => {
  const read = readBearerTokensFile(path);
  if (!read.ok) throw new Error(`The file reads with ${read.code}.`);
  return read.entries;
};

const writeEntries = (entries: readonly BearerTokenEntry[], mode = 0o600) => {
  writeFileSync(path, serializeBearerTokens(entries), { mode });
  chmodSync(path, mode);
};

const entry = (
  overrides: Partial<BearerTokenEntry> = {},
): BearerTokenEntry => ({
  name: 'claude-code-office',
  sha256: hashBearerToken(createBearerToken()),
  scopes: ['read'],
  createdAt: '2026-06-01',
  expiresAt: '2026-11-27',
  ...overrides,
});

describe('ecclium token create', () => {
  it('writes the hash with mode 0600 and the token alone to stdout, after the file', async () => {
    const result = await capture({
      action: 'create',
      name: 'claude-code-office',
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toHaveLength(1);
    const token = result.stdout[0] ?? '';
    expect(bearerTokenFormProblem(token)).toBeUndefined();
    expect(entriesOf()).toEqual([
      {
        name: 'claude-code-office',
        sha256: hashBearerToken(token),
        scopes: ['read'],
        createdAt: today,
        expiresAt: '2027-05-25',
      },
    ]);
    expect(modeOf(path)).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    expect(result.stderr).toEqual([
      'Das Token ‹claude-code-office› ist angelegt, mit den Scopes ‹read›, gültig bis und mit 25.05.2027 (UTC). Es steht nur in dieser Ausgabe, in keiner Datei: Legen Sie es jetzt beim Client ab.',
    ]);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('takes --write and --days', async () => {
    const result = await capture({
      action: 'create',
      name: 'buero',
      write: true,
      days: '7',
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(entriesOf()).toMatchObject([
      { scopes: ['read', 'write'], expiresAt: '2026-12-03' },
    ]);
    expect(result.stderr[0]).toContain('‹read› und ‹write›');
  });

  it('adds to a file that exists and refuses a name it has already', async () => {
    const other = entry({ name: 'other' });
    writeEntries([other]);
    expect((await capture({ action: 'create', name: 'buero' })).code).toBe(
      exitCodes.ok,
    );
    const before = readFileSync(path, 'utf8');
    const again = await capture({ action: 'create', name: 'buero' });
    expect(again.code).toBe(exitCodes.dataError);
    expect(again.stdout).toEqual([]);
    expect(again.stderr).toEqual([tokenTexts.nameTaken]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(entriesOf().map(({ name }) => name)).toEqual(['other', 'buero']);
  });

  it('refuses a name of another form with 64, before it reads anything, and never repeats it', async () => {
    const token = createBearerToken();
    for (const name of [undefined, '', 'Claude', 'claude.code', token]) {
      const result = await capture({ action: 'create', name });
      expect(result.code).toBe(exitCodes.usage);
      expect(result.stderr).toEqual([tokenTexts.nameInvalid]);
      expect(result.stderr.join('\n')).not.toContain(token.slice(12, 30));
    }
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses --days outside 1 to 365 or of another form with 64', async () => {
    for (const days of ['0', '366', '+5', '05', '1.5', '', ' 7', '1e2']) {
      const result = await capture({ action: 'create', name: 'buero', days });
      expect(result.code).toBe(exitCodes.usage);
      expect(result.stderr).toEqual([tokenTexts.daysInvalid]);
    }
    expect(
      (await capture({ action: 'create', name: 'buero', days: '365' })).code,
    ).toBe(exitCodes.ok);
    expect(entriesOf()[0]?.expiresAt).toBe('2027-11-26');
  });

  it('takes a 64th entry', async () => {
    writeEntries(
      Array.from({ length: 63 }, (_, index) =>
        entry({ name: `client-${String(index)}` }),
      ),
    );
    expect((await capture({ action: 'create', name: 'buero' })).code).toBe(
      exitCodes.ok,
    );
    expect(entriesOf()).toHaveLength(64);
  });

  it('shows the token only once its hash is in the file', async () => {
    const seen: boolean[] = [];
    const output: Output = {
      stdout: (text) => {
        const read = readBearerTokensFile(path);
        seen.push(
          read.ok &&
            read.entries.some(({ sha256 }) => sha256 === hashBearerToken(text)),
        );
        return true;
      },
      stderr: () => true,
    };
    const code = await runToken({
      environment: { ECCLIUM_HTTP_TOKENS_FILE: path },
      action: 'create',
      name: 'buero',
      clock,
      output,
    });
    expect(code).toBe(exitCodes.ok);
    expect(seen).toEqual([true]);
  });

  it('refuses a file with 64 entries', async () => {
    writeEntries(
      Array.from({ length: 64 }, (_, index) =>
        entry({ name: `client-${String(index)}` }),
      ),
    );
    const result = await capture({ action: 'create', name: 'buero' });
    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stderr).toEqual([tokenTexts.full]);
  });

  it('gives 74 and says to revoke when the token cannot be shown, with its hash in the file', async () => {
    const result = await capture({ action: 'create', name: 'buero' }, false);
    expect(result.code).toBe(exitCodes.ioError);
    expect(result.stderr).toEqual([tokenTexts.tokenNotShown]);
    expect(entriesOf()).toHaveLength(1);
  });
});

describe('ecclium token rotate', () => {
  it('makes a new token with the same scopes and lets the old one hold seven days at most', async () => {
    const old = entry({
      name: 'buero',
      scopes: ['read', 'write'],
      expiresAt: '2027-03-01',
    });
    const other = entry({ name: 'other' });
    writeEntries([old, other]);
    const result = await capture({ action: 'rotate', name: 'buero' });
    expect(result.code).toBe(exitCodes.ok);
    const token = result.stdout[0] ?? '';
    expect(entriesOf()).toEqual([
      other,
      { ...old, expiresAt: '2026-12-03' },
      {
        name: 'buero',
        sha256: hashBearerToken(token),
        scopes: ['read', 'write'],
        createdAt: today,
        expiresAt: '2027-05-25',
      },
    ]);
    expect(result.stderr).toEqual([
      'Das neue Token ‹buero› gilt bis und mit 25.05.2027 (UTC). Das bisherige gilt noch bis und mit 03.12.2026, danach nicht mehr. Legen Sie das neue jetzt beim Client ab: Es steht nur in dieser Ausgabe.',
    ]);
  });

  it('removes an old token that had expired already and says so', async () => {
    const old = entry({ name: 'buero', expiresAt: '2026-11-20' });
    const other = entry({ name: 'other' });
    writeEntries([old, other]);
    const result = await capture({ action: 'rotate', name: 'buero' });
    expect(result.code).toBe(exitCodes.ok);
    expect(entriesOf()).toEqual([
      other,
      expect.objectContaining({ name: 'buero', createdAt: today }),
    ]);
    expect(result.stderr).toEqual([
      'Das neue Token ‹buero› gilt bis und mit 25.05.2027 (UTC). Das bisherige war schon abgelaufen. Legen Sie das neue jetzt beim Client ab: Es steht nur in dieser Ausgabe.',
    ]);
  });

  it('keeps the file small however often a name rotates', async () => {
    writeEntries([entry({ name: 'buero' })]);
    let day = Date.UTC(2026, 10, 26, 12);
    for (let round = 0; round < 70; round += 1) {
      day += 3 * 86_400_000;
      const at = day;
      const result = await capture({
        action: 'rotate',
        name: 'buero',
        clock: { now: () => at },
      });
      expect(result.code).toBe(exitCodes.ok);
    }
    expect(entriesOf().length).toBeLessThanOrEqual(4);
  });

  it('never lets an old token outlive the new one', async () => {
    const old = entry({ name: 'buero', expiresAt: '2027-03-01' });
    writeEntries([old]);
    const result = await capture({
      action: 'rotate',
      name: 'buero',
      days: '2',
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(entriesOf().map(({ expiresAt }) => expiresAt)).toEqual([
      '2026-11-28',
      '2026-11-28',
    ]);
  });

  it('takes the scopes of the youngest entry of the name and clamps every old one', async () => {
    const older = entry({
      name: 'buero',
      createdAt: '2026-05-01',
      expiresAt: '2026-12-02',
    });
    const newer = entry({
      name: 'buero',
      scopes: ['read', 'write'],
      expiresAt: '2027-03-01',
    });
    writeEntries([newer, older]);
    const result = await capture({ action: 'rotate', name: 'buero' });
    expect(result.code).toBe(exitCodes.ok);
    expect(entriesOf()).toEqual([
      { ...newer, expiresAt: '2026-12-03' },
      older,
      expect.objectContaining({
        scopes: ['read', 'write'],
        createdAt: today,
      }),
    ]);
  });

  it('refuses to rotate in a file with 64 entries', async () => {
    writeEntries(
      Array.from({ length: 64 }, (_, index) =>
        entry({ name: index === 0 ? 'buero' : `client-${String(index)}` }),
      ),
    );
    const before = readFileSync(path, 'utf8');
    const result = await capture({ action: 'rotate', name: 'buero' });
    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stderr).toEqual([tokenTexts.full]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('gives 74 when the new token cannot be shown, with the rotation in the file', async () => {
    const old = entry({ name: 'buero', expiresAt: '2027-03-01' });
    writeEntries([old]);
    const result = await capture({ action: 'rotate', name: 'buero' }, false);
    expect(result.code).toBe(exitCodes.ioError);
    expect(result.stderr).toEqual([tokenTexts.tokenNotShown]);
    expect(entriesOf()).toHaveLength(2);
    expect(entriesOf()[0]?.expiresAt).toBe('2026-12-03');
  });

  it('leaves an old token that ends sooner as it is', async () => {
    const old = entry({ name: 'buero', expiresAt: '2026-11-28' });
    writeEntries([old]);
    expect(
      (await capture({ action: 'rotate', name: 'buero', days: '30' })).code,
    ).toBe(exitCodes.ok);
    expect(entriesOf()[0]).toEqual(old);
    expect(entriesOf()[1]?.expiresAt).toBe('2026-12-26');
  });

  it('refuses a name without a token with 65 and a missing file with 66', async () => {
    const missing = await capture({ action: 'rotate', name: 'buero' });
    expect(missing.code).toBe(exitCodes.noInput);
    expect(missing.stderr).toEqual([tokenTexts.missingForChange]);
    expect(readdirSync(folder)).toEqual([]);
    writeEntries([entry({ name: 'other' })]);
    const unknown = await capture({ action: 'rotate', name: 'buero' });
    expect(unknown.code).toBe(exitCodes.dataError);
    expect(unknown.stderr).toEqual([tokenTexts.nameUnknown]);
  });
});

describe('ecclium token revoke', () => {
  it('removes every entry of the name and keeps the others', async () => {
    const other = entry({ name: 'other' });
    writeEntries([
      entry({ name: 'buero' }),
      other,
      entry({ name: 'buero', createdAt: today }),
    ]);
    const result = await capture({ action: 'revoke', name: 'buero' });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      'Ab der nächsten Anfrage nimmt der Server kein Token mit dem Namen ‹buero› mehr an. Entfernt: 2 Einträge.',
    ]);
    expect(entriesOf()).toEqual([other]);
  });

  it('counts a single entry in the singular', async () => {
    writeEntries([entry({ name: 'buero' })]);
    expect((await capture({ action: 'revoke', name: 'buero' })).stderr).toEqual(
      [
        'Ab der nächsten Anfrage nimmt der Server kein Token mit dem Namen ‹buero› mehr an. Entfernt: 1 Eintrag.',
      ],
    );
    expect(entriesOf()).toEqual([]);
  });

  it('refuses a name without a token with 65', async () => {
    writeEntries([entry({ name: 'other' })]);
    const result = await capture({ action: 'revoke', name: 'buero' });
    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stderr).toEqual([tokenTexts.nameUnknown]);
  });
});

describe('ecclium token list', () => {
  it('shows name, scopes, days and state, never a hash', async () => {
    const entries = [
      entry({ name: 'zeta', expiresAt: '2027-05-25' }),
      entry({ name: 'alpha', scopes: ['read', 'write'], expiresAt: today }),
      entry({ name: 'beta', expiresAt: '2026-11-25' }),
      entry({ name: 'gamma', expiresAt: '2026-12-10' }),
      entry({ name: 'delta', expiresAt: '2026-11-27' }),
    ];
    writeEntries(entries);
    const result = await capture({ action: 'list' });
    expect(result.code).toBe(exitCodes.ok);
    // Without a folder of state the last use is unknown.
    expect(result.stdout).toEqual([
      'Name   Scopes      erstellt    gilt bis und mit  zuletzt benutzt  Zustand',
      'alpha  read,write  01.06.2026  26.11.2026        unbekannt        gilt nur noch heute',
      'beta   read        01.06.2026  25.11.2026        unbekannt        abgelaufen',
      'delta  read        01.06.2026  27.11.2026        unbekannt        gilt noch bis morgen',
      'gamma  read        01.06.2026  10.12.2026        unbekannt        läuft in 14 Tagen ab',
      'zeta   read        01.06.2026  25.05.2027        unbekannt        gilt',
    ]);
    for (const { sha256 } of entries) {
      expect(result.stdout.join('\n')).not.toContain(sha256.slice(0, 12));
    }
  });

  // The folder of state of the server, with its folder quota, in which
  // the check of the sign-in notes the last use (ADR 0074).
  const stateWith = (): string => {
    const state = join(folder, 'state');
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const prepared = prepareQuotaFolder(state);
    if (!prepared.ok) throw new Error(prepared.code);
    return state;
  };
  const tenant = 'default' as TenantId;

  it('names the day of the last use from the folder of state, the same for both entries of a rotation, and nie for a name without one', async () => {
    writeEntries([
      entry({ name: 'alpha', expiresAt: '2027-05-25' }),
      entry({
        name: 'alpha',
        createdAt: '2026-11-20',
        expiresAt: '2026-11-27',
      }),
      entry({ name: 'beta', expiresAt: '2027-05-25' }),
    ]);
    const state = stateWith();
    const store = createFileQuotaStore({
      stateDir: state,
      clock,
      pid: process.pid,
      host: 'example-host',
    });
    await store.noteLastUse(
      tenant,
      bearerLastUseKey('alpha'),
      '2026-11-25' as IsoDate,
    );
    const result = await capture({
      action: 'list',
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: path,
        ECCLIUM_STATE_DIR: state,
      },
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([
      'Name   Scopes  erstellt    gilt bis und mit  zuletzt benutzt  Zustand',
      'alpha  read    20.11.2026  27.11.2026        25.11.2026       gilt noch bis morgen',
      'alpha  read    01.06.2026  25.05.2027        25.11.2026       gilt',
      'beta   read    01.06.2026  25.05.2027        nie              gilt',
    ]);
  });

  it('names the last use as unknown when the folder quota is missing, and never creates it', async () => {
    writeEntries([entry({ name: 'alpha' })]);
    const state = join(folder, 'state');
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const result = await capture({
      action: 'list',
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: path,
        ECCLIUM_STATE_DIR: state,
      },
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout[1]).toContain('unbekannt');
    expect(readdirSync(state)).toEqual([]);
  });

  it('names one name as unknown when the store fails for it, and still lists the others', async () => {
    writeEntries([entry({ name: 'alpha' }), entry({ name: 'beta' })]);
    const state = stateWith();
    const memory = createMemoryQuotaStore();
    await memory.noteLastUse(
      tenant,
      bearerLastUseKey('beta'),
      '2026-11-24' as IsoDate,
    );
    const result = await capture({
      action: 'list',
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: path,
        ECCLIUM_STATE_DIR: state,
      },
      lastUseStore: {
        ...memory,
        readLastUse: (tenantId, key) =>
          key === bearerLastUseKey('alpha')
            ? Promise.reject(new Error('disk'))
            : memory.readLastUse(tenantId, key),
      },
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(
      result.stdout.slice(1).map((line) => line.split(/ {2,}/)[4]),
    ).toEqual(['unbekannt', '24.11.2026']);
  });

  it('stops with 78 for a folder of state that is no absolute path, before it reads anything', async () => {
    writeEntries([entry({ name: 'alpha' })]);
    const result = await capture({
      action: 'list',
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: path,
        ECCLIUM_STATE_DIR: 'state',
      },
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toEqual([]);
  });

  it('says so for a file without tokens and gives 66 without a file', async () => {
    writeEntries([]);
    expect((await capture({ action: 'list' })).stdout).toEqual([
      tokenTexts.empty,
    ]);
    rmSync(path);
    const missing = await capture({ action: 'list' });
    expect(missing.code).toBe(exitCodes.noInput);
    expect(missing.stderr).toEqual([tokenTexts.missingForList]);
  });
});

describe('ecclium token and its files', () => {
  it('stops with 78 without the variable, before it reads anything', async () => {
    const result = await capture({ action: 'list', environment: {} });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr[0]).toBe('Die Konfiguration hat 1 Problem:');
  });

  it('refuses a file that others may write, and a link, with 78 and writes nothing', async () => {
    writeEntries([entry({ name: 'other' })], 0o666);
    const before = readFileSync(path, 'utf8');
    const loose = await capture({ action: 'create', name: 'buero' });
    expect(loose.code).toBe(exitCodes.invalidConfig);
    expect(loose.stderr[0]).toContain('Gruppe oder andere Benutzer dürfen');
    expect(loose.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(modeOf(path)).toBe(0o666);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
    chmodSync(path, 0o600);
    const target = join(folder, 'target.yaml');
    writeFileSync(target, serializeBearerTokens([]), { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);
    const link = await capture({ action: 'list' });
    expect(link.code).toBe(exitCodes.invalidConfig);
    expect(link.stderr[0]).toContain('symbolischer Link');
  });

  it('refuses a folder at the path with 78 and an unreadable file with 74', async () => {
    mkdirSync(path);
    const folderThere = await capture({ action: 'create', name: 'buero' });
    expect(folderThere.code).toBe(exitCodes.invalidConfig);
    expect(folderThere.stderr[0]).toContain('keine gewöhnliche Datei');
    rmSync(path, { recursive: true });
    writeEntries([entry({ name: 'other' })]);
    const before = readFileSync(path, 'utf8');
    const unreadable = await capture({
      action: 'create',
      name: 'buero',
      readFiles: {
        ...nodeConfigFiles,
        openSync: () => {
          throw Object.assign(new Error('failed'), { code: 'EACCES' });
        },
      },
    });
    expect(unreadable.code).toBe(exitCodes.ioError);
    expect(unreadable.stderr[0]).toContain('konnte nicht gelesen werden');
    expect(unreadable.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('gives 74 and shows no token when the file cannot get its name', async () => {
    writeEntries([entry({ name: 'other' })]);
    const before = readFileSync(path, 'utf8');
    const result = await capture({
      action: 'create',
      name: 'buero',
      writeFiles: {
        ...nodeWriterFileSystem,
        renameSync: () => {
          throw Object.assign(new Error('refused'), { code: 'EACCES' });
        },
      },
    });
    expect(result.code).toBe(exitCodes.ioError);
    expect(result.stderr).toEqual([tokenTexts.unavailable]);
    expect(result.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('gives 75 while another command holds the lock and takes over a lock older than a minute', async () => {
    writeEntries([entry({ name: 'other' })]);
    const before = readFileSync(path, 'utf8');
    const lock = join(folder, '.http-tokens.yaml.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    const busy = await capture({ action: 'create', name: 'buero' });
    expect(busy.code).toBe(exitCodes.tempFail);
    expect(busy.stderr).toEqual([tokenTexts.busy]);
    expect(busy.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    // A list reads without the lock.
    expect((await capture({ action: 'list' })).code).toBe(exitCodes.ok);
    const stale = await capture({
      action: 'create',
      name: 'buero',
      clock: { now: () => Date.now() + 61_000 },
    });
    expect(stale.code).toBe(exitCodes.ok);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });

  it('holds the lock from before the read until after the write and releases it', async () => {
    const lockName = '.http-tokens.yaml.lock';
    const seen: boolean[] = [];
    const watching: WriterFileSystem = {
      ...nodeWriterFileSystem,
      renameSync: (from, to) => {
        seen.push(readdirSync(folder).includes(lockName));
        nodeWriterFileSystem.renameSync(from, to);
      },
    };
    const result = await capture({
      action: 'create',
      name: 'buero',
      writeFiles: watching,
      readFiles: {
        ...nodeConfigFiles,
        openSync: (target, flags) => {
          seen.push(readdirSync(folder).includes(lockName));
          return nodeConfigFiles.openSync(target, flags);
        },
      },
    });
    expect(result.code).toBe(exitCodes.ok);
    expect(seen).toEqual([true, true]);
    expect(readdirSync(folder)).not.toContain(lockName);
  });

  it('writes nothing and gives 75 when the file changes during the read', async () => {
    writeEntries([entry({ name: 'other' })]);
    const before = readFileSync(path, 'utf8');
    let looks = 0;
    // The second look, right after the read, sees another file.
    const changing: WriterFileSystem = {
      ...nodeWriterFileSystem,
      lstatSync: (target) => {
        const stats = nodeWriterFileSystem.lstatSync(target);
        looks += 1;
        return looks === 2
          ? {
              ...stats,
              isFile: () => true,
              isDirectory: () => false,
              ino: stats.ino + 1,
            }
          : stats;
      },
    };
    const result = await capture({
      action: 'create',
      name: 'buero',
      writeFiles: changing,
    });
    expect(result.code).toBe(exitCodes.tempFail);
    expect(result.stderr).toEqual([tokenTexts.changed]);
    expect(result.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('writes nothing and gives 75 when a file appears during the read of a missing one', async () => {
    let looks = 0;
    const appearing: WriterFileSystem = {
      ...nodeWriterFileSystem,
      lstatSync: (target) => {
        looks += 1;
        if (looks === 2) {
          writeEntries([entry({ name: 'other' })]);
        }
        return nodeWriterFileSystem.lstatSync(target);
      },
    };
    const result = await capture({
      action: 'create',
      name: 'buero',
      writeFiles: appearing,
    });
    expect(result.code).toBe(exitCodes.tempFail);
    expect(result.stdout).toEqual([]);
    expect(entriesOf().map(({ name }) => name)).toEqual(['other']);
  });

  it('refuses a folder that others may write with 78 and leaves no file', async () => {
    chmodSync(folder, 0o777);
    const result = await capture({ action: 'create', name: 'buero' });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr).toEqual([tokenTexts.unsafeFolder]);
    expect(result.stdout).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
    chmodSync(folder, 0o700);
  });

  it('writes nothing and gives 75 when the file changes before its name is set', async () => {
    writeEntries([entry({ name: 'other' })]);
    const before = readFileSync(path, 'utf8');
    let looks = 0;
    // The third look at the file is the last one before the rename: a
    // second command has changed it in between.
    const racing: WriterFileSystem = {
      ...nodeWriterFileSystem,
      lstatSync: (target) => {
        const stats = nodeWriterFileSystem.lstatSync(target);
        looks += 1;
        if (looks < 3) return stats;
        return {
          isFile: () => true,
          isDirectory: () => false,
          dev: stats.dev,
          ino: stats.ino,
          size: stats.size,
          mtimeMs: stats.mtimeMs + 1,
          uid: stats.uid,
          mode: stats.mode,
        };
      },
    };
    const result = await capture({
      action: 'create',
      name: 'buero',
      writeFiles: racing,
    });
    expect(result.code).toBe(exitCodes.tempFail);
    expect(result.stderr).toEqual([tokenTexts.changed]);
    expect(result.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(folder)).toEqual(['http-tokens.yaml']);
  });
});
