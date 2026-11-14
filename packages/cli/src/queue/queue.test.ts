import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { QueueEntryContent } from '@ecclium/mcp-churchtools-core';
import {
  createFileApprovalQueue,
  createFileDayKeys,
  createFileKeyProvider,
  createFileQuotaStore,
  createQueueKeeper,
  prepareQueueFolder,
  prepareQuotaFolder,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  approvalQuotaKey,
  type IsoDate,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { type Output, terminalLines, usageLine } from '../output/index.js';
import { type QueueAction, reportApprove, runQueue } from './queue.js';
import {
  approvedDiffHeading,
  approvedLines,
  approvedUnrecorded,
  approveFailedEnding,
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
  showFooterOf,
  timeOf,
  usedEnding,
  usedWords,
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
  stateDir = privateDir('ecclium-queue-state-');
  // The folder of the kill switches, which the operator makes and every
  // command with writing switched on needs (ADR 0029).
  mkdirSync(join(stateDir, 'stop'), { mode: 0o700 });
  keysDir = privateDir('ecclium-queue-keys-');
  configDir = privateDir('ecclium-queue-config-');
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
});

afterEach(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
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

// A hash as the core documents it in write/plan-hash.ts: after the tag of
// the encoding, each field as its length in bytes, a colon and its bytes.
const hashOf = (fields: readonly string[]): string => {
  const hash = createHash('sha256');
  for (const field of fields) {
    const bytes = new TextEncoder().encode(field);
    hash.update(`${String(bytes.byteLength)}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

// The text the entry that can be approved holds, as the content policy
// wrote it, and the text it writes, as ChurchTools stores it, without the
// line break at the end (F51); the hash of its plan for the actor of the
// start over stdio.
const newText = '# Neu\n';
const storedText = '# Neu';
const planHash = hashOf([
  'ecclium.plan.v1',
  'default',
  'user',
  'stdio:local-stdio',
  'ct_wiki_page_update',
  'wikiPageUpdate',
  'wiki_page',
  `12/${guid}`,
  '3',
  hashOf(['ecclium.content.v1', '1', storedText]),
]);

// An entry whose plan the core finds again on version 3 of the page.
const approvable = (queuedAt: number): QueueEntryContent => ({
  ...content(queuedAt),
  intent: {
    kind: 'wikiPageUpdate',
    categoryId: 12,
    guid,
    text: newText,
    baseVersion: 3,
  },
  planHash,
});

/** Keeps an entry as the pipeline of the server does. */
const keep = async (
  entryId = id,
  make: (queuedAt: number) => QueueEntryContent = content,
): Promise<number> => {
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
    { id: entryId, day: today(), content: make(queuedAt) },
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
    /** Added to the environment of the test. */
    readonly extra?: Readonly<Record<string, string>>;
    readonly cut?: boolean;
    readonly answer?: (double: MockedHttpTransport) => void;
    /** Whether the command runs with --runner. */
    readonly runner?: boolean;
  } = {},
): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const doubles: MockedHttpTransport[] = [];
  // The double forgets its calls when it closes, so they are counted as
  // the command closes the transport.
  let requests = 0;
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
    options.answer?.(double);
    return Object.freeze({
      ...double.transport,
      close: async () => {
        requests += double.calls().length;
        await double.transport.close();
      },
    });
  };
  const code = await runQueue({
    environment: options.environment ?? {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_KEYS_DIR: keysDir,
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_TOOLSETS: 'wiki',
      ECCLIUM_MARKER_KEY_FILE: join(configDir, 'marker-key'),
      ECCLIUM_POLICY_FILE: join(configDir, 'policy.yaml'),
      ...options.extra,
    },
    execArgv: [],
    action,
    ...(options.queueId === undefined ? {} : { queueId: options.queueId }),
    runner: options.runner === true,
    output,
    writeSync: (_fd, _buffer, _offset, length) => length,
    createTransport,
  });
  return {
    code,
    stdout,
    stderr,
    requests:
      requests +
      doubles.reduce((sum, double) => sum + double.calls().length, 0),
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
    // The name of the canary may hold a letter the terminal shows as its
    // code point, such as é.
    expect(result.stdout).toEqual(
      expect.arrayContaining(
        terminalLines('', `+# Neu ${canary.name.value}`, true),
      ),
    );
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

describe('ecclium queue --runner', () => {
  // The configuration of the runner, as its container holds it (ADR 0036):
  // without the token of the server and toolsets, with the folder of its
  // token files, which holds its own account, the folder of the kill
  // switches, a zone, the routines and a way out.
  const runnerCanary = makeCanaries().token;
  const runnerEnvironment = (): Record<string, string> => {
    const tokensDir = join(configDir, 'tokens');
    mkdirSync(tokensDir, { mode: 0o700 });
    writeFileSync(
      join(tokensDir, 'ct_token_runner'),
      `${runnerCanary.value}\n`,
      { mode: 0o600 },
    );
    return {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_KEYS_DIR: keysDir,
      ECCLIUM_KILL_SWITCH_DIR: join(stateDir, 'stop'),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_MARKER_KEY_FILE: join(configDir, 'marker-key'),
      ECCLIUM_POLICY_FILE: join(configDir, 'policy.yaml'),
      ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
      ECCLIUM_ROUTINES_DIR: join(configDir, 'routines'),
      ECCLIUM_TIME_ZONE: 'Europe/Zurich',
      ECCLIUM_EGRESS: 'off',
    };
  };

  it('lists, shows and rejects with the configuration of the runner, and asks ChurchTools nothing', async () => {
    await keep();
    const environment = runnerEnvironment();
    const listed = await run('list', { environment, runner: true });
    expect(listed.code).toBe(exitCodes.ok);
    expect(listed.stdout[1]).toContain('wartet auf Ihre Freigabe');
    const shown = await run('show', { queueId: id, environment, runner: true });
    expect(shown.code).toBe(exitCodes.ok);
    // The entry of the test comes from no run.
    expect(shown.stdout.at(-1)).toBe(showFooterOf(false));
    const rejected = await run('reject', {
      queueId: id,
      environment,
      runner: true,
    });
    expect(rejected.code).toBe(exitCodes.ok);
    expect(listed.requests + shown.requests + rejected.requests).toBe(0);
  });

  it('approves no entry of no run, before anything is sent, and the entry waits', async () => {
    await keep(id, approvable);
    const environment = runnerEnvironment();
    const refused = await run('approve', {
      queueId: id,
      environment,
      runner: true,
    });
    expect(refused.code).toBe(exitCodes.usage);
    expect(refused.stderr).toEqual([queueProblems.entry_of_no_run.text]);
    expect(refused.requests).toBe(0);
    const listed = await run('list', { environment, runner: true });
    expect(listed.stdout[1]).toContain('wartet auf Ihre Freigabe');
  });

  it('says of an entry it cannot approve what the approval says, without the pipeline', async () => {
    await keep();
    const environment = runnerEnvironment();
    const missing = await run('approve', {
      queueId: other,
      environment,
      runner: true,
    });
    expect(missing.code).toBe(exitCodes.noInput);
    expect(missing.stderr).toEqual([queueMissing.missing.text]);
    expect(
      (await run('reject', { queueId: id, environment, runner: true })).code,
    ).toBe(exitCodes.ok);
    const decided = await run('approve', {
      queueId: id,
      environment,
      runner: true,
    });
    expect(decided.code).toBe(exitCodes.dataError);
    expect(decided.stderr).toEqual([
      decidedEnding('rejected', undefined, false).text,
    ]);
    expect(missing.requests + decided.requests).toBe(0);
    // The two approvals ended before the pipeline, whose transport holds
    // the own account of the runner: only the rejection has a line.
    const decisions = readdirSync(join(stateDir, 'audit'))
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) =>
        readFileSync(join(stateDir, 'audit', name), 'utf8')
          .split('\n')
          .filter((line) => line !== ''),
      )
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['type'] === 'approval');
    expect(decisions.map((line) => line['decision'])).toEqual(['rejected']);
  });

  it('refuses the token of the server, as the runner does', async () => {
    await keep();
    const result = await run('list', {
      environment: {
        ...runnerEnvironment(),
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      },
      runner: true,
    });
    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toEqual([]);
    expect(all(result)).toContain('ECCLIUM_CHURCHTOOLS_TOKEN');
    expect(all(result)).not.toContain(canary.token.value);
  });
});

describe('ecclium queue approve', () => {
  const pagePath = `/api/wiki/categories/12/pages/${guid}`;
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
  // ChurchTools for an approval: the rights, the pages it reads, and the
  // write when it writes.
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
  const writing = answer(
    [
      [3, '# Plan'],
      [3, '# Plan'],
      [4, storedText],
    ],
    true,
  );

  it('writes the entry at once, shows what it changed, and decides it once', async () => {
    await keep(id, approvable);
    const result = await run('approve', { queueId: id, answer: writing });
    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout.slice(0, 2)).toEqual([
      'Freigegeben: Die Seite «Plan \\u{1b}[31m» in der Kategorie 12 ändern: 1 Zeile neu, 1 Zeile weg.',
      approvedDiffHeading,
    ]);
    expect(result.stdout).toEqual(
      expect.arrayContaining(['-# Plan', '+# Neu']),
    );
    expect(result.stdout.at(-2)).toBe(
      'Der Eintrag ist freigegeben und sein Inhalt vernichtet. Das Ziel steht jetzt in Version 4.',
    );
    expect(result.stdout.at(-1)).toMatch(
      /^Zurücknehmen lässt sich der Schreibvorgang mit ‹ecclium undo [0-9a-f-]{36}›\.$/,
    );
    expect(result.requests).toBe(5);
    expect(readdirSync(join(stateDir, 'quota'))).toEqual([
      `default-${today()}.approvals.json`,
    ]);
    expect(readdirSync(join(stateDir, 'audit')).length).toBe(1);
    expect(all(result)).not.toContain(stateDir);
    const again = await run('approve', { queueId: id });
    expect(again.code).toBe(exitCodes.dataError);
    expect(again.stderr).toEqual([
      decidedEnding('approved', undefined, false).text,
    ]);
    expect(again.requests).toBe(0);
  });

  it('writes nothing, decides nothing and leaves the entry waiting when the page changed since', async () => {
    await keep(id, approvable);
    const result = await run('approve', {
      queueId: id,
      answer: answer([[4, '# Von Hand\n']]),
    });
    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stderr).toEqual([
      approveFailedEnding({
        code: 'conflict',
        reason: 'changedSinceQueued',
        used: false,
        sent: false,
      }).text,
    ]);
    const listed = await run('list');
    expect(listed.stdout[1]).toContain('wartet auf Ihre Freigabe');
  });

  it('refuses to approve while the server only reads, before anything is read', async () => {
    await keep(id, approvable);
    const result = await run('approve', {
      queueId: id,
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
        ECCLIUM_STATE_DIR: stateDir,
        ECCLIUM_KEYS_DIR: keysDir,
      },
    });
    expect(result.code).toBe(exitCodes.noPermission);
    expect(result.stderr).toEqual([queueProblems.read_only.text]);
    expect(result.requests).toBe(0);
  });

  it('writes nothing while writing is switched off, and the entry waits', async () => {
    await keep(id, approvable);
    writeFileSync(join(stateDir, 'stop', 'writes-off'), '');
    const result = await run('approve', { queueId: id, answer: writing });
    expect(result.code).toBe(exitCodes.noPermission);
    expect(result.stderr[0]).toContain('Kill-Switch');
    expect(result.stderr[0]).toContain('Der Eintrag wartet weiter');
    expect(result.requests).toBe(0);
  });

  // The command looks for a switch only in the folder the configuration
  // names (ADR 0029), not in the empty folder stop of the folder of state.
  it('writes nothing for a switch in the folder of ECCLIUM_KILL_SWITCH_DIR', async () => {
    await keep(id, approvable);
    const switches = join(configDir, 'kill-switches');
    mkdirSync(switches, { mode: 0o700 });
    writeFileSync(join(switches, 'writes-off'), '');
    const result = await run('approve', {
      queueId: id,
      answer: writing,
      extra: { ECCLIUM_KILL_SWITCH_DIR: switches },
    });
    expect(result.code).toBe(exitCodes.noPermission);
    expect(result.stderr[0]).toContain('Kill-Switch');
    expect(result.requests).toBe(0);
  });

  it('shows an entry whose decision was counted but not kept as decided, and decides it no more', async () => {
    await keep(id, approvable);
    prepareQuotaFolder(stateDir);
    // A process stopped between the count and the decision.
    await createFileQuotaStore({
      stateDir,
      clock: systemClock,
      pid: process.pid,
      host: 'test-host',
    }).increment(
      {
        tenantId: 'default',
        actor: { kind: 'user', id: 'stdio:local-stdio' },
      } as unknown as TenantContext,
      approvalQuotaKey(hashOf(['ecclium.approval.v1', id, planHash])),
      today(),
    );
    const listed = await run('list');
    expect(listed.stdout).toEqual([
      listHeading,
      `${id}  ${today().slice(8, 10)}.${today().slice(5, 7)}.${today().slice(0, 4)}  ${usedWords}`,
    ]);
    const shown = await run('show', { queueId: id });
    expect(shown.code).toBe(exitCodes.ok);
    expect(shown.stdout).toEqual([usedEnding(true).text]);
    for (const action of ['approve', 'reject'] as const) {
      const decided = await run(action, { queueId: id, answer: writing });
      expect(decided.code).toBe(exitCodes.dataError);
      expect(decided.stderr).toEqual([usedEnding(false).text]);
    }
  });

  it('ends with 78 when the folder of the counters is not private, for approve and reject', async () => {
    await keep(id, approvable);
    mkdirSync(join(stateDir, 'quota'), { mode: 0o700 });
    chmodSync(join(stateDir, 'quota'), 0o755);
    for (const action of ['approve', 'reject'] as const) {
      const result = await run(action, { queueId: id });
      expect(result.code).toBe(exitCodes.invalidConfig);
      expect(result.stderr[0]).toContain('‹quota›');
      expect(result.stderr[0]).toContain('chmod 700');
    }
  });

  it.each([
    ['of the day keys of the snapshots', () => join(keysDir, 'snapshot')],
    ['of the snapshots', () => join(stateDir, 'snapshots')],
  ])(
    'ends with 78 when the folder %s is not private',
    async (_name, folder) => {
      await keep(id, approvable);
      mkdirSync(folder(), { mode: 0o700 });
      chmodSync(folder(), 0o755);
      const result = await run('approve', { queueId: id });
      expect(result.code).toBe(exitCodes.invalidConfig);
      expect(result.stderr[0]).toContain('chmod 700');
      expect(all(result)).not.toContain(stateDir);
    },
  );

  it('ends with 74 after its own text when the line of an approval did not reach the audit file', () => {
    const lines: { readonly to: string; readonly text: string }[] = [];
    const output: Output = {
      stdout: (text) => {
        lines.push({ to: 'stdout', text });
        return true;
      },
      stderr: (text) => {
        lines.push({ to: 'stderr', text });
        return true;
      },
    };
    const diff = { hunks: [], replaced: false };
    const written = reportApprove(output, {
      kind: 'approved',
      summary: 'Die Seite ändern.',
      target: { kind: 'wiki_page', key: `12/${guid}` },
      version: 4,
      undoId: id,
      diff,
      unrecorded: true,
    });
    expect(written).toBe(exitCodes.ioError);
    expect(lines[0]).toEqual({
      to: 'stdout',
      text: 'Freigegeben: Die Seite ändern.',
    });
    expect(lines.at(-1)).toEqual({
      to: 'stderr',
      text: approvedUnrecorded.text,
    });
    lines.length = 0;
    const failed = reportApprove(output, {
      kind: 'failed',
      code: 'network',
      used: true,
      sent: true,
      diff,
      unrecorded: true,
    });
    expect(failed).toBe(exitCodes.ioError);
    expect(lines.map(({ text }) => text)).toEqual([
      'Die Freigabe sollte so schreiben, mit ‹-› für Zeilen davor und ‹+› für Zeilen danach:',
      approveFailedEnding({ code: 'network', used: true, sent: true }).text,
      approvedUnrecorded.text,
    ]);
  });

  it('lists the commands of an entry in the footers', () => {
    expect(listFooter).toContain('‹ecclium queue approve <Kennung>›');
    expect(listFooter).toContain('‹--runner›');
    expect(showFooterOf(false)).toContain('‹ecclium queue approve›');
    expect(showFooterOf(false)).not.toContain('--runner');
    // An entry of a run is decided with the configuration of the runner.
    expect(showFooterOf(true)).toContain('‹ecclium queue approve --runner›');
    expect(showFooterOf(true)).toContain('‹ecclium queue reject --runner›');
  });

  it('names --runner for the undo of an approval only with the runner', () => {
    expect(approvedLines(4, id).at(-1)).toBe(
      `Zurücknehmen lässt sich der Schreibvorgang mit ‹ecclium undo ${id}›.`,
    );
    expect(approvedLines(4, id, true).at(-1)).toBe(
      `Zurücknehmen lässt sich der Schreibvorgang mit ‹ecclium undo --runner ${id}›.`,
    );
  });
});

describe('the endings of an approval', () => {
  it.each([
    [{ code: 'policy_denied', reason: 'blocked' }, exitCodes.noPermission],
    [{ code: 'policy_denied', reason: 'readOnly' }, exitCodes.noPermission],
    [
      { code: 'policy_denied', reason: 'switchUnknown' },
      exitCodes.noPermission,
    ],
    [{ code: 'policy_denied', reason: 'notRun' }, exitCodes.noPermission],
    [{ code: 'validation', reason: 'intent' }, exitCodes.dataError],
    [{ code: 'validation', reason: 'blank' }, exitCodes.dataError],
    [
      { code: 'policy_denied', reason: 'rightsUnknown' },
      exitCodes.noPermission,
    ],
    [{ code: 'permission', reason: 'missingRight' }, exitCodes.noPermission],
    [{ code: 'policy_denied', reason: 'notMarkdown' }, exitCodes.noPermission],
    [{ code: 'conflict', reason: 'changedBefore' }, exitCodes.dataError],
    [{ code: 'conflict', reason: 'changedSincePlan' }, exitCodes.dataError],
    [{ code: 'policy_denied', reason: 'clock' }, exitCodes.noPermission],
    [{ code: 'network', reason: 'notSent' }, exitCodes.unavailable],
    [{ code: 'network', reason: 'unknown' }, exitCodes.unavailable],
    [{ code: 'conflict', reason: 'notAsPlanned' }, exitCodes.unavailable],
    [{ code: 'internal', reason: 'notConfirmed' }, exitCodes.internal],
    [{ code: 'internal', reason: 'noSnapshot' }, exitCodes.ioError],
    [{ code: 'policy_denied', reason: 'auditNotReady' }, exitCodes.ioError],
    [{ code: 'validation', reason: 'content' }, exitCodes.dataError],
    [{ code: 'auth' }, exitCodes.noPermission],
    [{ code: 'permission' }, exitCodes.noPermission],
    [{ code: 'not_found' }, exitCodes.noInput],
    [{ code: 'conflict' }, exitCodes.dataError],
    [{ code: 'validation' }, exitCodes.dataError],
    [{ code: 'network' }, exitCodes.unavailable],
    [{ code: 'upstream' }, exitCodes.unavailable],
    [{ code: 'rate_limited' }, exitCodes.unavailable],
    [{ code: 'policy_denied' }, exitCodes.noPermission],
    [{ code: 'internal' }, exitCodes.internal],
  ] as const)('end %j with its code', (failure, code) => {
    const waits = approveFailedEnding({ ...failure, used: false, sent: false });
    expect(waits.code).toBe(code);
    expect(waits.text).toMatch(
      /Der Eintrag wartet weiter auf Ihre Freigabe\.$/,
    );
    const used = approveFailedEnding({ ...failure, used: true, sent: false });
    expect(used.text).toContain('Die Freigabe ist verbraucht');
  });

  it('say that a count which did not answer in time leaves the entry unknown', () => {
    const unknown = approveFailedEnding({
      code: 'internal',
      reason: 'countUnknown',
      used: false,
      sent: false,
    });
    expect(unknown.code).toBe(exitCodes.internal);
    expect(unknown.text).toContain('‹ecclium queue list›');
    expect(unknown.text).not.toContain('wartet weiter');
    expect(failedEnding({ code: 'internal', reason: 'countUnknown' })).toEqual(
      unknown,
    );
    // A rejection counted but not kept says that the entry is decided.
    const counted = failedEnding({ code: 'internal', used: true });
    expect(counted.code).toBe(exitCodes.internal);
    expect(counted.text).toContain('nicht mehr entscheiden');
  });

  it('say what a refusal of ChurchTools means, and what a write that may have landed means', () => {
    // A refusal carries the sentence that the write did not land, but its
    // code says why.
    expect(
      approveFailedEnding({
        code: 'permission',
        reason: 'notSent',
        used: true,
        sent: false,
      }).code,
    ).toBe(exitCodes.noPermission);
    expect(
      approveFailedEnding({ code: 'conflict', used: true, sent: true }).text,
    ).toContain('liest sich danach nicht wie geplant');
    expect(
      approveFailedEnding({ code: 'network', used: true, sent: true }).text,
    ).toContain('ist unbekannt');
    // A target that changed since the write was queued says itself what
    // is left to do.
    expect(
      approveFailedEnding({
        code: 'conflict',
        reason: 'changedSinceQueued',
        used: false,
        sent: false,
      }).text,
    ).toMatch(/neu planen\.$/);
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
