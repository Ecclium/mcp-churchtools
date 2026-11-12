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

import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  calendarsAnswer,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
  resourcesAnswer,
  resourceTypesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Output } from '../output/index.js';
import { usageLine } from '../output/index.js';
import { initPolicy, type PolicyInitOptions } from './init.js';
import {
  namesFailedText,
  outputCutText,
  partlyReadText,
  policyInitCallTexts,
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
  state: 'verified' | 'denied' = 'verified',
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
    outcome: state === 'verified' ? 'ok' : 'denied',
    writeState: state,
    objectRefs: ['wiki_category:12'],
    ...(state === 'verified' ? {} : { errorCode: 'policy_denied' }),
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
  it('needs --interactive or --routine', async () => {
    const result = await run({ interactive: false });
    expect(result.code).toBe(64);
    expect(result.stderr).toEqual([
      policyInitCallTexts.mode_missing,
      usageLine,
    ]);
    expect(result.stdout).toEqual([]);
    expect(result.transports).toBe(0);
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
      '# Ein Eintrag je Kategorie des Wikis, die das Audit in einer Zeile eines Schreib-Tools nennt, auch bei abgelehnten Versuchen.',
      '# maxPerDay ist das Doppelte des höchsten Tageswerts eines Tools, mindestens 5, ohne abgelehnte und übersprungene Aufrufe.',
      '# Prüfen Sie jeden Eintrag, bevor Sie die Datei mit ECCLIUM_POLICY_FILE einsetzen.',
      'schema: policy.v1',
      'interactive:',
      '  targets:',
      '    - target: { kind: wiki_category, id: 12, name: "Berichte" }',
      `      tools: [${create}, ${update}]`,
      '      maxPerDay: 5',
      '    # Nur abgelehnte oder übersprungene Versuche im Audit: Prüfen Sie, ob Ecclium hier schreiben soll.',
      '    - target: { kind: wiki_category, id: 20, name: "Gemeindebüro «Süd»" }',
      `      tools: [${create}]`,
      '      maxPerDay: 5',
      '    # Kategorie 99: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.',
      '  readBudgetPerDay: 200',
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

  it('writes a category whose name had hidden characters only as a comment, and keeps the file from loading', async () => {
    auditFiles({ [fileName(1)]: [write()] });
    const result = await run({ answer: names([[12, 'Ber\u200Bichte']]) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '    # Kategorie 12: Ihr Name kam verändert an, ohne unsichtbare Zeichen oder mit einem maskierten Teil, darum kein Eintrag. Tragen Sie ihn von Hand ein.',
    );
    expect(result.stdout.join('\n')).not.toContain('id: 12,');
    expect(result.stdout).toContain('    - ERSETZEN');
  });

  it('writes a category whose name the level strict masked only as a comment', async () => {
    const keys = mkdtempSync(join(tmpdir(), 'ecclium-policy-key-'));
    try {
      const keyFile = join(keys, 'pseudonym-key');
      writeFileSync(
        keyFile,
        `${createHash('sha256').update('policy init').digest('hex')}\n`,
        { mode: 0o600 },
      );
      chmodSync(keyFile, 0o600);
      auditFiles({
        [fileName(1)]: [write(), write({ objectRefs: ['wiki_category:20'] })],
      });
      const result = await run({
        environment: {
          ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
          ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
          ECCLIUM_STATE_DIR: dir,
          ECCLIUM_TOOLSETS: 'wiki',
          ECCLIUM_REDACTION: 'strict',
          ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
        },
        answer: names([
          [12, 'Kontakt max.mustermann@example.org'],
          [20, 'Berichte'],
        ]),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        '    # Kategorie 12: Ihr Name kam verändert an, ohne unsichtbare Zeichen oder mit einem maskierten Teil, darum kein Eintrag. Tragen Sie ihn von Hand ein.',
      );
      expect(result.stdout).toContain(
        '    - target: { kind: wiki_category, id: 20, name: "Berichte" }',
      );
    } finally {
      rmSync(keys, { recursive: true, force: true });
    }
  });

  it('asks for no further page once every category has its name', async () => {
    const many = Array.from(
      { length: 30 },
      (_, index) => [index + 1, `Kategorie ${String(index + 1)}`] as const,
    );
    auditFiles({ [fileName(1)]: [write({ objectRefs: ['wiki_category:3'] })] });
    // One answer only: a second page would find no answer and end with 69.
    const result = await run({ answer: names(many) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '    - target: { kind: wiki_category, id: 3, name: "Kategorie 3" }',
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
    expect(result.stderr[0]).toBe(namesFailedText('upstream', 'categories'));
  });

  // The lists of calendars and resources, each read whole by its tool.
  const calendarNames =
    (calendars: readonly (readonly [number, string])[]) =>
    (double: MockedHttpTransport): void => {
      double.intercept({ path: '/api/calendars', method: 'GET' }).reply(
        200,
        calendarsAnswer(
          calendars.map(([id, name]) => ({
            id,
            name,
            isPublic: true,
            isPrivate: false,
          })),
        ).body,
        json,
      );
    };
  const resourceNames =
    (resources: readonly (readonly [number, string])[]) =>
    (double: MockedHttpTransport): void => {
      double
        .intercept({ path: '/api/resources', method: 'GET' })
        .reply(
          200,
          resourcesAnswer(
            resources.map(([id, name]) => ({ id, name, resourceTypeId: 5 })),
          ).body,
          json,
        );
      double
        .intercept({ path: '/api/resourcetypes', method: 'GET' })
        .reply(200, resourceTypesAnswer([{ id: 5, name: 'Räume' }]).body, json);
    };
  const calendarsOnly = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
    ECCLIUM_STATE_DIR: '',
    ECCLIUM_TOOLSETS: 'calendars',
  };
  const appointment = (objectRefs: readonly string[]) =>
    write({ tool: 'ct_appointments_create', objectRefs });
  const booking = (objectRefs: readonly string[]) =>
    write({ tool: 'ct_bookings_create', objectRefs });

  it('proposes calendars and resources with their names from ChurchTools', async () => {
    auditFiles({
      [fileName(1)]: [
        appointment(['calendar:8', 'appointment:21']),
        appointment(['calendar:8', 'appointment:22']),
        booking(['resource:13', 'booking:51']),
        booking(['resource:14']),
      ],
    });
    const result = await run({
      environment: { ...calendarsOnly, ECCLIUM_STATE_DIR: dir },
      answer: (double) => {
        calendarNames([
          [8, 'Gottesdienste'],
          [9, 'Jugend'],
        ])(double);
        resourceNames([[13, 'Saal «Süd»']])(double);
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      '# Vorschlag von «ecclium policy init --interactive» für den interaktiven Teil der Richtlinie.',
      '# Grundlage: die Audit-Dateien vom 2026-10-30 bis 2026-10-30 (UTC).',
      '# Ein Eintrag je Kategorie des Wikis, je Kalender und je Ressource, die das Audit in einer Zeile eines Schreib-Tools nennt, auch bei abgelehnten Versuchen.',
      '# maxPerDay ist das Doppelte des höchsten Tageswerts eines Tools, mindestens 5, ohne abgelehnte und übersprungene Aufrufe.',
      '# Prüfen Sie jeden Eintrag, bevor Sie die Datei mit ECCLIUM_POLICY_FILE einsetzen.',
      'schema: policy.v1',
      'interactive:',
      '  targets:',
      '    - target: { kind: calendar, id: 8, name: "Gottesdienste" }',
      '      tools: [ct_appointments_create]',
      '      maxPerDay: 5',
      '    - target: { kind: resource, id: 13, name: "Saal «Süd»" }',
      '      tools: [ct_bookings_create]',
      '      maxPerDay: 5',
      '    # Ressource 14: ChurchTools nennt dem Konto keinen Namen, darum kein Eintrag.',
      '  readBudgetPerDay: 200',
    ]);
    // Its calls stand in a new audit file, in the mode operator.
    const own = readdirSync(join(dir, 'audit')).filter(
      (name) => name !== fileName(1),
    );
    const lines = readFileSync(join(dir, 'audit', own[0] ?? ''), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toMatchObject([
      { tool: 'ct_calendars_list', mode: 'operator', outcome: 'ok' },
      { tool: 'ct_resources_list', mode: 'operator', outcome: 'ok' },
    ]);
    expect(result.logs.join('')).not.toContain(canary.token.value);
  });

  it('asks for categories, calendars and resources in one run', async () => {
    auditFiles({
      [fileName(1)]: [write(), appointment(['calendar:8'])],
    });
    const result = await run({
      environment: {
        ...calendarsOnly,
        ECCLIUM_STATE_DIR: dir,
        ECCLIUM_TOOLSETS: 'wiki,calendars',
      },
      answer: (double) => {
        names([[12, 'Berichte']])(double);
        calendarNames([[8, 'Gottesdienste']])(double);
      },
    });
    expect(result.code).toBe(0);
    expect(result.transports).toBe(1);
    expect(result.stdout).toContain(
      '    - target: { kind: wiki_category, id: 12, name: "Berichte" }',
    );
    expect(result.stdout).toContain(
      '    - target: { kind: calendar, id: 8, name: "Gottesdienste" }',
    );
  });

  it('needs the toolset calendars for the names of calendars and resources', async () => {
    for (const line of [
      appointment(['calendar:8']),
      booking(['resource:13']),
    ]) {
      rmSync(join(dir, 'audit'), { recursive: true, force: true });
      auditFiles({ [fileName(1)]: [line] });
      const result = await run();
      expect(result.code).toBe(78);
      expect(result.stderr).toEqual([policyInitTexts.calendars_off]);
      expect(result.transports).toBe(0);
    }
  });

  it('ends with 69 and writes nothing when ChurchTools gives no names of the calendars', async () => {
    auditFiles({ [fileName(1)]: [appointment(['calendar:8'])] });
    const result = await run({
      environment: { ...calendarsOnly, ECCLIUM_STATE_DIR: dir },
      answer: (double) => {
        double
          .intercept({ path: '/api/calendars', method: 'GET' })
          .reply(500, '{}', json);
      },
    });
    expect(result.code).toBe(69);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([namesFailedText('upstream', 'calendars')]);
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
