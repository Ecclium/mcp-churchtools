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

import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Output } from '../output/index.js';
import { usageLine } from '../output/index.js';
import { initPolicy, type PolicyInitOptions } from './init.js';
import {
  namesFailedText,
  outputCutText,
  partlyReadText,
  policyInitTexts,
} from './texts.js';

// The command against a folder of state on disk with audit files written
// here and the test double of ChurchTools in place of an instance.

const canary = makeCanaries();
const create = 'ct_wiki_page_create';
const update = 'ct_wiki_page_update';
const json = { headers: { 'content-type': 'application/json' } };

let dir: string;
let events = 0;
const open: MockedHttpTransport[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-policy-init-'));
  chmodSync(dir, 0o700);
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

/** A line of a call of a write tool, with the fields an event needs. */
const write = (
  fields: Record<string, unknown> = {},
  state: 'planned' | 'denied' = 'planned',
): string => {
  events += 1;
  return JSON.stringify({
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(events).padStart(12, '0')}`,
    ts: '2026-10-30T08:00:00.000Z',
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool: create,
    outcome: state === 'planned' ? 'ok' : 'denied',
    writeState: state,
    objectRefs: ['wiki_category:12'],
    ...(state === 'planned' ? {} : { errorCode: 'policy_denied' }),
    durationMs: 4,
    ...fields,
  });
};

/** Writes the audit files into the folder audit of the folder of state. */
const auditFiles = (
  files: Readonly<Record<string, readonly string[]>>,
  mode = 0o600,
): void => {
  const folder = join(dir, 'audit');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  for (const [name, lines] of Object.entries(files)) {
    const path = join(folder, name);
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    chmodSync(path, mode);
  }
};

const fileName = (number: number): string =>
  `audit-2026-10-30-120000-4242-${String(number)}.jsonl`;

const categoryList = (categories: readonly (readonly [number, string])[]) =>
  JSON.stringify({
    data: categories.map(([id, name]) => ({
      id,
      name,
      permissions: { canEdit: false, canDelete: false },
    })),
    meta: { count: categories.length },
    permissions: { editMasterData: false },
  });

interface Run {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly logs: readonly string[];
  readonly transports: number;
}

const run = async (
  options: {
    readonly interactive?: boolean;
    readonly environment?: Readonly<Record<string, string>>;
    readonly answer?: (double: MockedHttpTransport) => void;
    readonly cut?: boolean;
  } = {},
): Promise<Run> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];
  let transports = 0;
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
  const decoder = new TextDecoder();
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
  const replacements: Pick<PolicyInitOptions, 'writeSync' | 'createTransport'> =
    {
      writeSync: (_fd, buffer, offset, length) => {
        logs.push(decoder.decode(buffer.subarray(offset, offset + length)));
        return length;
      },
      createTransport,
    };
  const code = await initPolicy({
    environment: options.environment ?? {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ECCLIUM_STATE_DIR: dir,
      ECCLIUM_TOOLSETS: 'wiki',
    },
    execArgv: [],
    interactive: options.interactive ?? true,
    output,
    ...replacements,
  });
  return { code, stdout, stderr, logs, transports };
};

const names =
  (categories: readonly (readonly [number, string])[]) =>
  (double: MockedHttpTransport): void => {
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(200, categoryList(categories), json);
  };

describe('ecclium policy init', () => {
  it('needs --interactive', async () => {
    const result = await run({ interactive: false });
    expect(result.code).toBe(64);
    expect(result.stderr).toEqual([
      policyInitTexts.interactive_missing,
      usageLine,
    ]);
    expect(result.stdout).toEqual([]);
  });

  it('ends with 78 for an invalid configuration and without a folder of state', async () => {
    const invalid = await run({ environment: {} });
    expect(invalid.code).toBe(78);
    expect(invalid.stderr.length).toBeGreaterThan(0);
    const withoutState = await run({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      },
    });
    expect(withoutState.code).toBe(78);
    expect(withoutState.stderr).toEqual([policyInitTexts.state_dir_missing]);
  });

  it('ends with 66 without the folder audit', async () => {
    const result = await run();
    expect(result.code).toBe(66);
    expect(result.stdout).toEqual([]);
  });

  it('proposes an empty list without asking ChurchTools when the audit names no category', async () => {
    auditFiles({ [fileName(1)]: [write({ objectRefs: [] })] });
    const result = await run({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
        ECCLIUM_STATE_DIR: dir,
        // Without the wiki: no category, so no names to ask for.
        ECCLIUM_TOOLSETS: 'persons',
      },
    });
    expect(result.code).toBe(0);
    expect(result.transports).toBe(0);
    expect(result.stdout).toContain('  targets: []');
    expect(result.stdout).toContain('schema: policy.v1');
  });

  it('proposes one entry per category with its name from ChurchTools', async () => {
    auditFiles({
      [fileName(1)]: [
        write(),
        write(),
        write({ tool: update }),
        write({ objectRefs: ['wiki_category:20'] }, 'denied'),
        write({ objectRefs: ['wiki_category:99'] }),
      ],
    });
    const result = await run({
      answer: names([
        [12, 'Berichte'],
        [20, 'Gemeindebüro «Süd»'],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      '# Vorschlag von «ecclium policy init --interactive» für den interaktiven Teil der Richtlinie.',
      '# Grundlage: die Audit-Dateien vom 2026-10-30 bis 2026-10-30 (UTC).',
      '# Ein Eintrag je Kategorie des Wikis, auf die ein Schreib-Tool zugegriffen hat, auch wenn es abgelehnt wurde.',
      '# maxPerDay ist das Doppelte des höchsten Tageswerts eines Tools, mindestens 5.',
      '# Prüfen Sie jeden Eintrag, bevor Sie die Datei mit ECCLIUM_POLICY_FILE einsetzen.',
      'schema: policy.v1',
      'interactive:',
      '  readBudgetPerDay: 200',
      '  targets:',
      '    - target: { kind: wiki_category, id: 12, name: "Berichte" }',
      `      tools: [${create}, ${update}]`,
      '      maxPerDay: 5',
      '    - target: { kind: wiki_category, id: 20, name: "Gemeindebüro «Süd»" }',
      `      tools: [${create}]`,
      '      maxPerDay: 5',
      '    # Kategorie 99: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.',
    ]);
    // Its own call stands in a new audit file, in the mode operator, and
    // the anchor of that file in the log.
    const own = readdirSync(join(dir, 'audit')).filter(
      (name) => name !== fileName(1),
    );
    expect(own).toHaveLength(1);
    const lines = readFileSync(join(dir, 'audit', own[0] ?? ''), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toMatchObject([
      { tool: 'ct_wiki_categories_list', mode: 'operator', outcome: 'ok' },
    ]);
    expect(result.logs.join('')).toContain('"event":"audit_chain_anchor"');
    expect(result.logs.join('')).not.toContain(canary.token.value);
  });

  it('asks for the next page while the list has more', async () => {
    const many = Array.from(
      { length: 30 },
      (_, index) => [index + 1, `Kategorie ${String(index + 1)}`] as const,
    );
    auditFiles({
      [fileName(1)]: [write({ objectRefs: ['wiki_category:27'] })],
    });
    const result = await run({
      answer: (double) => {
        names(many)(double);
        names(many)(double);
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '    - target: { kind: wiki_category, id: 27, name: "Kategorie 27" }',
    );
  });

  it('writes a category whose name had hidden characters only as a comment', async () => {
    auditFiles({ [fileName(1)]: [write()] });
    const result = await run({ answer: names([[12, 'Ber​ichte']]) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '    # Kategorie 12: Ihr Name enthält unsichtbare Zeichen, darum kein Eintrag. Tragen Sie ihn von Hand ein.',
    );
  });

  it('needs the toolset wiki for the names', async () => {
    auditFiles({ [fileName(1)]: [write()] });
    const result = await run({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
        ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
        ECCLIUM_STATE_DIR: dir,
        ECCLIUM_TOOLSETS: 'persons',
      },
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toEqual([policyInitTexts.wiki_off]);
    expect(result.transports).toBe(0);
  });

  it('ends with 69 and writes nothing when ChurchTools gives no names', async () => {
    auditFiles({ [fileName(1)]: [write()] });
    const result = await run({
      answer: (double) => {
        double
          .intercept({ path: '/api/wiki/categories', method: 'GET' })
          .reply(500, '{}', json);
      },
    });
    expect(result.code).toBe(69);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toBe(namesFailedText('upstream'));
  });

  it('ends with 74 when the proposal does not reach stdout', async () => {
    auditFiles({ [fileName(1)]: [write({ objectRefs: [] })] });
    const result = await run({ cut: true });
    expect(result.code).toBe(74);
    expect(result.stdout).toHaveLength(1);
    expect(result.stderr).toEqual([outputCutText]);
  });

  it('writes the proposal and ends with 74 when a file could not be read', async () => {
    auditFiles({ [fileName(1)]: [write({ objectRefs: [] })] });
    auditFiles({ [fileName(2)]: [write({ objectRefs: [] })] }, 0o644);
    const result = await run();
    expect(result.code).toBe(74);
    expect(result.stdout).toContain('schema: policy.v1');
    expect(result.stderr).toEqual([partlyReadText]);
  });
});
