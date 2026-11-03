import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { QueueEntryContent } from '@ecclium/mcp-churchtools-core';
import {
  createFileApprovalQueue,
  createFileDayKeys,
  createFileKeyProvider,
  createQueueKeeper,
  prepareQueueFolder,
  systemClock,
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

import { exitCodes } from '../exit-codes.js';
import { type Output, usageLine } from '../output/index.js';
import { type QueueAction, runQueue } from './queue.js';
import {
  decidedEnding,
  diffHeading,
  failedEnding,
  listEmpty,
  listFooter,
  listHeading,
  queueMissing,
  queueProblems,
  reasonTexts,
  rejectedEnding,
  timeOf,
} from './texts.js';

// The commands against folders of state and keys on disk, with an entry
// sealed here as the pipeline of the server keeps it, and the test double
// of ChurchTools in place of an instance, which none of them asks
// (ADR 0031).

const canary = makeCanaries();
const guid = '00000000-0000-4000-8000-0000000000ab';
const id = '11111111-2222-4333-8444-555555555555';
const other = '11111111-2222-4333-8444-555555555556';

let stateDir: string;
let keysDir: string;
const open: MockedHttpTransport[] = [];

const privateDir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return path;
};

beforeEach(() => {
  stateDir = privateDir('ecclium-queue-state-');
  keysDir = privateDir('ecclium-queue-keys-');
});

afterEach(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

// The day of the entry is today, so that it is valid and its day key
// exists.
const today = (): IsoDate => new Date().toISOString().slice(0, 10) as IsoDate;

const content = (queuedAt: number): QueueEntryContent => ({
  tool: 'ct_wiki_page_update',
  origin: 'core',
  toolMeta: { sensitivity: 'personal', unattended: 'policy' },
  actor: { kind: 'user', id: 'stdio:local-stdio' },
  intent: {
    kind: 'wikiPageUpdate',
    categoryId: 12,
    guid,
    text: `# Neu ${canary.name.value}\n`,
    baseVersion: 3,
  },
  planHash: 'c'.repeat(64),
  target: { kind: 'wiki_page', key: `12/${guid}` },
  summary: `Die Seite «Plan \u001b[31m» in der Kategorie 12 ändern: 1 Zeile neu, 1 Zeile weg.`,
  diff: ['@@ -1,1 +1,1 @@', '-# Plan', `+# Neu ${canary.name.value}`],
  reason: 'no_question',
  queuedAt,
});

/** Keeps an entry as the pipeline of the server does. */
const keep = async (entryId = id): Promise<number> => {
  prepareQueueFolder(stateDir);
  const keeper = createQueueKeeper({
    keys: createFileKeyProvider({
      dayKeys: createFileDayKeys({ keysDir, pid: process.pid }),
    }),
    store: createFileApprovalQueue({ stateDir, pid: process.pid }),
    clock: systemClock,
  });
  const queuedAt = Date.parse(`${today()}T00:00:00.000Z`);
  await keeper.enqueue(
    { tenantId: 'default', instance: doubleOrigin } as unknown as TenantContext,
    { id: entryId, day: today(), content: content(queuedAt) },
  );
  return queuedAt;
};

interface Run {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly requests: number;
}

const run = async (
  action: QueueAction,
  options: {
    readonly queueId?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly cut?: boolean;
  } = {},
): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const doubles: MockedHttpTransport[] = [];
  const output: Output = {
    stdout: (text) => {
      stdout.push(text);
      return options.cut !== true;
    },
    stderr: (text) => {
      stderr.push(text);
      return true;
    },
  };
  const createTransport = (settings: HttpTransportOptions): HttpTransport => {
    const double = createChurchToolsDouble({
      token: settings.token,
      origin: settings.origin,
      logger: settings.logger,
    });
    open.push(double);
    doubles.push(double);
    return double.transport;
  };
  const code = await runQueue({
    environment: options.environment ?? {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_KEYS_DIR: keysDir,
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_TOOLSETS: 'wiki',
    },
    execArgv: [],
    action,
    ...(options.queueId === undefined ? {} : { queueId: options.queueId }),
    output,
    writeSync: (_fd, _buffer, _offset, length) => length,
    createTransport,
  });
  return {
    code,
    stdout,
    stderr,
    requests: doubles.reduce((sum, double) => sum + double.calls().length, 0),
  };
};

const all = (result: Run): string =>
  [...result.stdout, ...result.stderr].join('\n');

describe('ecclium queue list', () => {
  it('lists what waits with its summary safe for the terminal and why, and asks ChurchTools nothing', async () => {
    const queuedAt = await keep();
    const result = await run('list');
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([
      listHeading,
      `${id}  ${timeOf(new Date(queuedAt).toISOString())}  wartet auf Ihre Freigabe`,
      '    Die Seite «Plan \\u{1b}[31m» in der Kategorie 12 ändern: 1 Zeile neu, 1 Zeile weg.',
      `    Grund: ${reasonTexts.no_question}`,
      listFooter,
    ]);
    expect(result.requests).toBe(0);
    expect(all(result)).not.toContain('\u001b');
    expect(all(result)).not.toContain(stateDir);
  });

  it('says so when nothing waits, and prepares the folder of the queue as the start does', async () => {
    const result = await run('list');
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([listHeading, listEmpty]);
    expect(readdirSync(join(stateDir, 'queue'))).toEqual([]);
  });

  it('ends with 78 and the text of the folder when the folder of the queue is not private', async () => {
    mkdirSync(join(stateDir, 'queue'), { mode: 0o700 });
    chmodSync(join(stateDir, 'queue'), 0o755);
    for (const action of ['list', 'show', 'reject'] as const) {
      const result = await run(action, { queueId: id });
      expect(result.code).toBe(exitCodes.invalidConfig);
      expect(result.stderr[0]).toContain('‹queue›');
      expect(result.stderr[0]).toContain('und der Befehl bricht ab.');
      expect(all(result)).not.toContain(stateDir);
    }
  });

  it('lists a rejected entry with its decision, and an expired one', async () => {
    await keep();
    expect((await run('reject', { queueId: id })).code).toBe(exitCodes.ok);
    const listed = await run('list');
    expect(listed.stdout).toHaveLength(2);
    expect(listed.stdout[1]).toMatch(
      new RegExp(`^${id}  \\d{2}\\.\\d{2}\\.\\d{4}  abgewiesen am `),
    );
    rmSync(join(keysDir, 'queue'), { recursive: true, force: true });
    await keep(other);
    rmSync(join(keysDir, 'queue'), { recursive: true, force: true });
    const expired = await run('list');
    expect(expired.stdout.at(-1)).toMatch(/verfallen$/);
  });

  it('needs the folder of state and the folder of keys', async () => {
    const base = {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
    };
    const withoutState = await run('list', { environment: base });
    expect(withoutState.code).toBe(exitCodes.invalidConfig);
    expect(withoutState.stderr).toEqual([queueProblems.state_dir_missing.text]);
    const withoutKeys = await run('list', {
      environment: { ...base, ECCLIUM_STATE_DIR: stateDir },
    });
    expect(withoutKeys.code).toBe(exitCodes.invalidConfig);
    expect(withoutKeys.stderr).toEqual([queueProblems.keys_dir_missing.text]);
  });

  it('refuses an invalid configuration with its problems', async () => {
    const result = await run('list', {
      environment: { ECCLIUM_CHURCHTOOLS_URL: 'not a url' },
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('ecclium queue show', () => {
  it('shows the text the core made visible once, and the marks of the diff in German', async () => {
    prepareQueueFolder(stateDir);
    const keeper = createQueueKeeper({
      keys: createFileKeyProvider({
        dayKeys: createFileDayKeys({ keysDir, pid: process.pid }),
      }),
      store: createFileApprovalQueue({ stateDir, pid: process.pid }),
      clock: systemClock,
    });
    await keeper.enqueue(
      {
        tenantId: 'default',
        instance: doubleOrigin,
      } as unknown as TenantContext,
      {
        id,
        day: today(),
        content: {
          ...content(Date.now()),
          summary: 'Die Seite «C:\\\\Pfad» ändern.',
          diff: [
            '@@ -1,1 +1,1 @@',
            '-a\\\\b',
            '\\ No newline at end of file',
            '+a\\u{200b}b é',
            '\\ Line ends with CR LF',
          ],
        },
      },
    );
    const result = await run('show', { queueId: id });
    expect(result.stdout).toEqual(
      expect.arrayContaining([
        'Die Seite «C:\\\\Pfad» ändern.',
        '-a\\\\b',
        '\\ ohne Zeilenumbruch am Ende',
        '+a\\u{200b}b \\u{e9}',
        '\\ Zeile endet mit CR LF',
      ]),
    );
  });

  it('shows the whole entry, every text safe for the terminal', async () => {
    await keep();
    const result = await run('show', { queueId: id });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout[0]).toContain(
      'von ‹ct_wiki_page_update›, für die Seite',
    );
    expect(result.stdout).toContain(diffHeading);
    expect(result.stdout).toContain(`+# Neu ${canary.name.value}`);
    expect(all(result)).not.toContain('\u001b');
    expect(result.requests).toBe(0);
  });

  it('shows the whole title of a new page', async () => {
    prepareQueueFolder(stateDir);
    const keeper = createQueueKeeper({
      keys: createFileKeyProvider({
        dayKeys: createFileDayKeys({ keysDir, pid: process.pid }),
      }),
      store: createFileApprovalQueue({ stateDir, pid: process.pid }),
      clock: systemClock,
    });
    await keeper.enqueue(
      {
        tenantId: 'default',
        instance: doubleOrigin,
      } as unknown as TenantContext,
      {
        id,
        day: today(),
        content: {
          ...content(Date.now()),
          intent: {
            kind: 'wikiPageCreate',
            categoryId: 12,
            title: 'Bericht',
            text: 'x',
          },
          target: { kind: 'wiki_category', key: '12' },
          title: 'Bericht',
        },
      },
    );
    const result = await run('show', { queueId: id });
    expect(result.stdout).toContain('Titel der neuen Seite: Bericht');
    expect(result.stdout[0]).toContain('eine neue Seite in der Kategorie 12');
  });

  it('says that an entry is decided, and that none is under another ID', async () => {
    await keep();
    await run('reject', { queueId: id });
    const decided = await run('show', { queueId: id });
    expect(decided.code).toBe(exitCodes.ok);
    expect(decided.stdout[0]).toMatch(
      /^Über diesen Eintrag ist schon entschieden: abgewiesen am .* UTC\./,
    );
    const missing = await run('show', { queueId: other });
    expect(missing.code).toBe(exitCodes.noInput);
    expect(missing.stderr).toEqual([queueMissing.missing.text]);
  });

  it('refuses an ID that is no UUID before it reads anything, and names it in no text', async () => {
    for (const given of [
      '../x',
      '0F1E2D3C-4B5A-4978-8A6B-5C4D3E2F1A0B',
      `${id} `,
      '',
    ]) {
      const result = await run('show', { queueId: given });
      expect(result.code).toBe(exitCodes.usage);
      expect(result.stderr).toEqual([queueProblems.id_invalid.text, usageLine]);
    }
  });

  it('says when stdout took not all', async () => {
    await keep();
    const result = await run('show', { queueId: id, cut: true });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stderr.at(-1)).toContain('nicht ganz auf stdout');
  });
});

describe('ecclium queue reject', () => {
  it('rejects an entry, destroys its content and writes one line into the audit file', async () => {
    await keep();
    const result = await run('reject', { queueId: id });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([
      'Abgewiesen: Die Seite «Plan \\u{1b}[31m» in der Kategorie 12 ändern: 1 Zeile neu, 1 Zeile weg.',
      rejectedEnding.text,
    ]);
    expect(result.requests).toBe(0);
    const day = readdirSync(join(stateDir, 'queue'));
    expect(readdirSync(join(stateDir, 'queue', day[0] ?? ''))).toEqual([
      `default.${id}.decision`,
    ]);
    expect(readdirSync(join(stateDir, 'audit')).length).toBe(1);
    const again = await run('reject', { queueId: id });
    expect(again.code).toBe(exitCodes.dataError);
    expect(again.stderr).toEqual([
      decidedEnding('rejected', undefined, false).text,
    ]);
  });

  it('finds nothing under another ID', async () => {
    await keep();
    const result = await run('reject', { queueId: other });
    expect(result.code).toBe(exitCodes.noInput);
    expect(result.stderr).toEqual([queueMissing.missing.text]);
  });

  it('decides nothing when the audit file cannot be opened', async () => {
    await keep();
    mkdirSync(join(stateDir, 'audit'), { mode: 0o755 });
    chmodSync(join(stateDir, 'audit'), 0o755);
    const result = await run('reject', { queueId: id });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stderr[0]).toContain('‹audit›');
    expect(all(result)).not.toContain(stateDir);
    // The entry still waits.
    chmodSync(join(stateDir, 'audit'), 0o700);
    expect((await run('show', { queueId: id })).code).toBe(exitCodes.ok);
  });
});

describe('the endings of ecclium queue', () => {
  it('give every code of a failure its text and exit code', () => {
    expect(failedEnding({ code: 'validation' })).toBe(queueProblems.id_invalid);
    expect(failedEnding({ code: 'policy_denied' }).code).toBe(
      exitCodes.noPermission,
    );
    expect(failedEnding({ code: 'auth' }).code).toBe(exitCodes.noPermission);
    expect(failedEnding({ code: 'internal' }).code).toBe(exitCodes.internal);
    expect(
      failedEnding({ code: 'policy_denied', reason: 'auditNotReady' }).code,
    ).toBe(exitCodes.ioError);
    expect(queueMissing.off.code).toBe(exitCodes.noInput);
    expect(queueMissing.expired.code).toBe(exitCodes.noInput);
    expect(decidedEnding('approved', '2026-11-03T18:00:00.000Z', true)).toEqual(
      {
        text: 'Über diesen Eintrag ist schon entschieden: freigegeben am 03.11.2026 18:00:00 UTC. Sein Inhalt ist vernichtet.',
        code: exitCodes.ok,
      },
    );
  });
});
