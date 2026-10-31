import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AuditSummary,
  AuditVerifyReport,
} from '@ecclium/mcp-churchtools-core/audit';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { maxOutputLength, type Output, usageLine } from '../output/index.js';
import { isTextLine } from '../send.js';
import { showAudit } from './audit-show.js';
import {
  auditFolderTexts,
  auditShowProblemTexts,
  logUnreadableText,
  renderObjectHits,
  renderSummary,
  renderVerifyReport,
} from './audit-texts.js';
import { verifyAudit } from './audit-verify.js';

// The commands at real folders and files, built as the server writes
// them: a chain from the name of the file, and the anchor as a line of the
// log. The name of the base folder holds a canary, so that a path in any
// output would show.

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const canary = makeCanary('token').cores[0] ?? '';
const base = mkdtempSync(join(tmpdir(), `ecclium-audit-${canary}-`));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const fileName = (number: number, day = '2026-10-30'): string =>
  `audit-${day}-080000-4242-${String(number)}.jsonl`;

let events = 0;
const event = (fields: Record<string, unknown> = {}): string => {
  events += 1;
  const outcome = fields['outcome'] ?? 'ok';
  return JSON.stringify({
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(events).padStart(12, '0')}`,
    ts: '2026-10-30T08:00:00.000Z',
    type: 'tool_call',
    tenantId: 'default',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    mode: 'interactive',
    tool: 'ct_persons_get',
    outcome,
    objectRefs: [],
    ...(outcome === 'ok' ? {} : { errorCode: 'policy_denied' }),
    durationMs: 3,
    ...fields,
  });
};

/** The lines of a file with the chain the writer puts into them. */
const chained = (name: string, lines: readonly string[]): string[] => {
  let previous = sha256(name);
  let seq = 0;
  return lines.map((line) => {
    seq += 1;
    const link = `${line.slice(0, -1)},"seq":${String(seq)},"prevHash":"${previous}"}`;
    previous = sha256(link);
    return link;
  });
};

const anchorLine = (name: string, lines: readonly string[]): string => {
  const last = lines.at(-1) ?? '';
  return `2026-10-30T08:00:01.000Z [ecclium] [info] {"ts":"2026-10-30T08:00:01.000Z","level":"info","event":"audit_chain_anchor","file":"${name}","seq":${String(lines.length)},"hash":"${sha256(last)}"}`;
};

let states = 0;

/** A private folder of state with the given audit files. */
const makeState = (
  files: Readonly<Record<string, readonly string[]>>,
): { stateDir: string; auditDir: string } => {
  states += 1;
  const stateDir = join(base, `state-${String(states)}`);
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const auditDir = join(stateDir, 'audit');
  mkdirSync(auditDir, { mode: 0o700 });
  chmodSync(auditDir, 0o700);
  for (const [name, lines] of Object.entries(files)) {
    const path = join(auditDir, name);
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''), {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  }
  return { stateDir, auditDir };
};

const putLog = (lines: readonly string[]): string => {
  states += 1;
  const path = join(base, `log-${String(states)}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
};

interface Captured {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

const capture = (run: (output: Output) => number): Captured => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = run({
    stdout: (line) => stdout.push(line) > 0,
    stderr: (line) => stderr.push(line) > 0,
  });
  for (const line of [...stdout, ...stderr]) {
    expect(isTextLine(line, maxOutputLength), line).toBe(true);
    expect(line).not.toContain(canary);
  }
  return { code, stdout, stderr };
};

const verify = (stateDir: string | undefined, logs: readonly string[] = []) =>
  capture((output) =>
    verifyAudit({
      environment:
        stateDir === undefined ? {} : { ECCLIUM_STATE_DIR: stateDir },
      logs,
      output,
      clock: { now: () => Date.UTC(2026, 9, 31, 12) },
    }),
  );

const show = (
  stateDir: string | undefined,
  values: { object?: string; since?: string; until?: string } = {},
) =>
  capture((output) =>
    showAudit({
      environment:
        stateDir === undefined ? {} : { ECCLIUM_STATE_DIR: stateDir },
      ...values,
      output,
    }),
  );

describe('ecclium audit verify', () => {
  const name = fileName(1);
  const lines = chained(name, [
    event(),
    event({ objectRefs: ['person:12'] }),
    event({ outcome: 'denied', withheldAfterRead: true }),
  ]);

  it('finds the chains whole and says that the anchors are missing', () => {
    const { stateDir } = makeState({ [name]: lines });

    const result = verify(stateDir);

    expect(result.code).toBe(exitCodes.ok);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toContain('  Ganze Zeilen geprüft: 3');
    expect(result.stdout).toContain(
      'Ohne ‹--log› prüft Ecclium nur die Ketten. Eine gekürzte Datei oder eine geänderte letzte Zeile zeigt erst ein Anker aus dem Log.',
    );
    expect(result.stdout.at(-1)).toBe(
      'Ergebnis: Die Ketten der Audit-Dateien sind ganz.',
    );
    expect(result.stdout.join('\n')).not.toContain('person:12');
  });

  it('checks the anchors of one or more logs', () => {
    const { stateDir } = makeState({ [name]: lines });
    const log = putLog(['other line', anchorLine(name, lines)]);
    const again = putLog([anchorLine(name, lines)]);

    const result = verify(stateDir, [log, again]);

    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toContain(
      '  Dateien mit einem Anker aus dem Log: 1, davon passend 1, nach Ablauf der Frist gelöscht 0',
    );
    expect(result.stdout.at(-1)).toBe(
      'Ergebnis: Die Ketten der Audit-Dateien sind ganz und passen zu den Ankern aus dem Log.',
    );
  });

  it('finds a changed line and a changed last line with 65', () => {
    const changed = [...lines];
    changed[0] = (changed[0] ?? '').replace('"durationMs":3', '"durationMs":4');
    changed[2] = (changed[2] ?? '').replace('"durationMs":3', '"durationMs":5');
    const { stateDir } = makeState({ [name]: changed });
    const log = putLog([anchorLine(name, lines)]);

    const result = verify(stateDir, [log]);

    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stdout).toContain('Befunde: 2');
    expect(result.stdout).toContain(
      `  - ${name}, Zeile 2: Die Kette bricht vor dieser Zeile. Davor wurde eine Zeile geändert, entfernt, eingefügt oder verschoben.`,
    );
    expect(result.stdout).toContain(
      `  - ${name}: Die Zeile, die der Anker im Log nennt, ist nicht mehr dieselbe.`,
    );
    expect(result.stdout.at(-1)).toMatch(
      /^Ergebnis: Die Audit-Dateien stimmen nicht/,
    );
  });

  it('finds a file that went before its retention', () => {
    const { stateDir } = makeState({});
    const log = putLog([anchorLine(fileName(5), lines)]);

    const result = verify(stateDir, [log]);

    expect(result.code).toBe(exitCodes.dataError);
    expect(result.stdout).toContain(
      `  - ${fileName(5)}: Ein Anker im Log nennt diese Datei, sie fehlt aber im Ordner, und ihre Frist ist nicht abgelaufen.`,
    );
  });

  it('counts files without a chain and gives 0 for them', () => {
    const { stateDir } = makeState({ [name]: [event(), event()] });

    const result = verify(stateDir);

    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toContain(
      '  Dateien ohne Kette, aus einer Version von Ecclium vor der Kette: 1',
    );
  });

  it('gives 74 for a file it cannot read and nothing else', () => {
    if (process.getuid?.() === 0) return;
    const { stateDir, auditDir } = makeState({ [name]: lines });
    chmodSync(join(auditDir, name), 0o000);

    const result = verify(stateDir);

    chmodSync(join(auditDir, name), 0o600);
    expect(result.code).toBe(exitCodes.ioError);
    expect(result.stdout.at(-1)).toMatch(/^Ergebnis: Nicht jede Datei/);
  });

  it('gives 66 for a log it cannot read, without its path', () => {
    const { stateDir } = makeState({ [name]: lines });

    const result = verify(stateDir, [join(base, 'no-such-log')]);

    expect(result).toEqual({
      code: exitCodes.noInput,
      stdout: [],
      stderr: [logUnreadableText],
    });
  });

  it('gives 66 without the folder audit and 78 for one with rights for others', () => {
    const missing = makeState({});
    rmSync(missing.auditDir, { recursive: true });
    const open = makeState({});
    chmodSync(open.auditDir, 0o755);

    expect(verify(missing.stateDir)).toEqual({
      code: exitCodes.noInput,
      stdout: [],
      stderr: [auditFolderTexts.audit_folder_missing],
    });
    // The loader checks the folder audit as the start does, before the
    // reader opens it.
    const unsafe = verify(open.stateDir);
    expect(unsafe.code).toBe(exitCodes.invalidConfig);
    expect(unsafe.stdout).toEqual([]);
    expect(unsafe.stderr[0]).toBe('Die Konfiguration hat 1 Problem:');
  });

  it('gives 78 without the folder of state and names the problem', () => {
    const result = verify(undefined);

    expect(result.code).toBe(exitCodes.invalidConfig);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toBe('Die Konfiguration hat 1 Problem:');
    expect(result.stderr[1]).toMatch(
      /^ {2}- ‹ECCLIUM_STATE_DIR› ist nicht gesetzt\./,
    );
  });

  it('reads no file of the folder of state other than the audit files', () => {
    const { stateDir } = makeState({ [name]: lines });
    writeFileSync(join(stateDir, 'audit', 'notes.txt'), 'x');

    const result = verify(stateDir);

    expect(result.stdout).toContain(
      '  Andere Einträge im Ordner, nicht geprüft: 1',
    );
    expect(readFileSync(join(stateDir, 'audit', 'notes.txt'), 'utf8')).toBe(
      'x',
    );
  });
});

describe('ecclium audit show', () => {
  const name = fileName(1);
  const lines = chained(name, [
    event({ objectRefs: ['person:12', 'group:7'] }),
    event({ tool: 'ct_groups_get', objectRefs: ['group:7'] }),
    event({
      ts: '2026-10-31T09:30:00.000Z',
      outcome: 'denied',
      withheldAfterRead: true,
      objectRefs: ['person:12'],
    }),
  ]);

  it('counts the calls per day and tool and names no ID', () => {
    const { stateDir } = makeState({ [name]: lines });

    const result = show(stateDir);

    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout).toEqual([
      'Aufrufe je Tag und Tool, Tage in UTC',
      '30.10.2026',
      '  ct_groups_get: 1 Aufruf, 1 ausgeführt',
      '  ct_persons_get: 1 Aufruf, 1 ausgeführt',
      '31.10.2026',
      '  ct_persons_get: 1 Aufruf, 1 abgelehnt, davon 1 nach dem Lesen zurückgehalten',
      'Gelesen: 1 von 1 Datei, 3 Zeilen im Zeitraum.',
      'Die Auswertung prüft die Ketten nicht. Das tut ‹ecclium audit verify›.',
    ]);
    expect(result.stdout.join('\n')).not.toMatch(/person:|group:/);
  });

  it('counts only the days of the range', () => {
    const { stateDir } = makeState({ [name]: lines });

    const result = show(stateDir, { since: '2026-10-31', until: '2026-10-31' });

    expect(result.stdout.slice(0, 3)).toEqual([
      'Aufrufe je Tag und Tool, Tage in UTC',
      'Zeitraum: vom 31.10.2026 bis und mit 31.10.2026',
      '31.10.2026',
    ]);
  });

  it('lists the calls that name an ID, with subject and outcome', () => {
    const { stateDir } = makeState({ [name]: lines });

    const result = show(stateDir, { object: 'person:12' });

    expect(result.code).toBe(exitCodes.ok);
    expect(result.stdout.slice(0, 4)).toEqual([
      'Aufrufe, die ‹person:12› nennen, Zeiten in UTC',
      '  30.10.2026 08:00:00  ct_persons_get  Subjekt stdio:local-stdio  ausgeführt',
      '  31.10.2026 09:30:00  ct_persons_get  Subjekt stdio:local-stdio  abgelehnt, nach dem Lesen zurückgehalten',
      '2 Zeilen nennen ‹person:12›.',
    ]);
    expect(result.stdout.join('\n')).not.toContain('group:7');
  });

  it('refuses a value of the wrong form without repeating it', () => {
    const { stateDir } = makeState({ [name]: lines });
    const cases: [
      Record<string, string>,
      keyof typeof auditShowProblemTexts,
    ][] = [
      [{ object: `person:${canary}` }, 'object'],
      [{ object: 'Person:12' }, 'object'],
      [{ since: '31.10.2026' }, 'day'],
      [{ until: '2026-02-30' }, 'day'],
      [{ since: '2026-10-31', until: '2026-10-30' }, 'range'],
    ];
    for (const [values, problem] of cases) {
      expect(show(stateDir, values)).toEqual({
        code: exitCodes.usage,
        stdout: [],
        stderr: [auditShowProblemTexts[problem], usageLine],
      });
    }
  });

  it('gives 78 without the folder of state and 66 without the folder audit', () => {
    const missing = makeState({});
    rmSync(missing.auditDir, { recursive: true });

    expect(show(undefined).code).toBe(exitCodes.invalidConfig);
    expect(show(missing.stateDir)).toEqual({
      code: exitCodes.noInput,
      stdout: [],
      stderr: [auditFolderTexts.audit_folder_missing],
    });
  });

  it('gives 74 when a file cannot be read and says so', () => {
    if (process.getuid?.() === 0) return;
    const { stateDir, auditDir } = makeState({
      [name]: lines,
      [fileName(2)]: lines,
    });
    chmodSync(join(auditDir, fileName(2)), 0o000);

    const result = show(stateDir);

    chmodSync(join(auditDir, fileName(2)), 0o600);
    expect(result.code).toBe(exitCodes.ioError);
    expect(result.stdout).toContain(
      '1 Datei liess sich nicht lesen und fehlt in der Auswertung.',
    );
  });
});

// Every line the commands can write, from reports that hold every case.
const verifyReport = (
  changes: Partial<AuditVerifyReport> = {},
): AuditVerifyReport => ({
  files: 1_234,
  checked: 1_200,
  unchained: 3,
  lines: 45_678,
  others: 2,
  vanished: 1,
  anchors: 1_000,
  anchorsMatched: 990,
  anchorsExpired: 10,
  findings: [
    { kind: 'line_form', file: fileName(1), line: 2 },
    { kind: 'line_too_long', file: fileName(1), line: 3 },
    { kind: 'chain_mixed', file: fileName(1), line: 4 },
    { kind: 'chain_name', file: fileName(1), line: 1 },
    { kind: 'chain_link', file: fileName(1), line: 12_345 },
    { kind: 'chain_seq', file: fileName(1), line: 6 },
    { kind: 'anchor_mismatch', file: fileName(2) },
    { kind: 'anchor_truncated', file: fileName(2) },
    { kind: 'anchor_extended', file: fileName(2) },
    { kind: 'anchor_conflict', file: fileName(2) },
    { kind: 'file_missing', file: fileName(3) },
    { kind: 'file_unsafe', file: fileName(4) },
    { kind: 'file_unreadable', file: fileName(5) },
    { kind: 'folder_moved', file: fileName(6) },
  ],
  findingsOmitted: 1,
  ...changes,
});

const summary = (changes: Partial<AuditSummary> = {}): AuditSummary => ({
  files: 1_234,
  read: 1_230,
  unread: 4,
  moved: true,
  lines: 98_765,
  skipped: 2,
  rows: [
    {
      day: '2026-10-30',
      tool: 'ct_persons_search',
      calls: 1_500,
      ok: 1_000,
      error: 300,
      denied: 200,
      withheld: 20,
    },
    {
      day: '2026-10-30',
      tool: undefined,
      calls: 1,
      ok: 0,
      error: 0,
      denied: 1,
      withheld: 0,
    },
  ],
  hits: [
    {
      ts: '2026-10-30T08:00:00.000Z',
      tool: undefined,
      actorId: 'stdio:team-a',
      outcome: 'error',
      withheld: false,
    },
  ],
  hitsOmitted: 5_000,
  partial: 1,
  ...changes,
});

const rendered = (): readonly (readonly [string, readonly string[]])[] => [
  [
    'a report with every finding',
    renderVerifyReport(verifyReport(), undefined),
  ],
  [
    'a report with anchors and dropped ones',
    renderVerifyReport(verifyReport({ findingsOmitted: 0 }), {
      anchors: new Map(),
      conflicts: [],
      dropped: 3,
    }),
  ],
  [
    'a report with an unreadable file only',
    renderVerifyReport(
      verifyReport({
        findings: [{ kind: 'file_unreadable', file: fileName(1) }],
        findingsOmitted: 0,
      }),
      undefined,
    ),
  ],
  ['a summary', renderSummary(summary(), { since: '2026-10-01' })],
  [
    'an empty summary in a range',
    renderSummary(summary({ rows: [], skipped: 1, unread: 1 }), {
      until: '2026-10-31',
    }),
  ],
  ['an empty summary', renderSummary(summary({ rows: [] }), {})],
  [
    'the hits of an ID',
    renderObjectHits(summary(), 'person:12', {
      since: '2026-10-01',
      until: '2026-10-31',
    }),
  ],
  [
    'no hit of an ID',
    renderObjectHits(
      summary({ hits: [], hitsOmitted: 0, partial: 0 }),
      'group:7',
      {},
    ),
  ],
  ['the texts of a wrong value', Object.values(auditShowProblemTexts)],
  ['the texts of the folder', Object.values(auditFolderTexts)],
  ['the text of a log', [logUnreadableText]],
];

// Printable ASCII, the quotes «» and ‹› and the umlauts, as the tripwire of
// the writers allows them.
const allowed = /^[ -~«»‹›äöüÄÖÜ]+$/;

describe('the texts of the audit commands', () => {
  it.each(rendered())(
    'keep %s to lines of allowed characters, after the rules of the brand',
    (_, lines) => {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(isTextLine(line, maxOutputLength), line).toBe(true);
        expect(line, line).toMatch(allowed);
        // Dates, days in the form of the command line, times and names of
        // audit files are no numbers of the kind the brand writes as 4'096.
        const text = line
          .replace(/audit-\S+\.jsonl/g, '')
          .replace(/\d{2}\.\d{2}\.\d{4}/g, '')
          .replace(/\d{4}-\d{2}-\d{2}/g, '');
        expect(text.replace(/(?<=\d)'(?=\d{3})/g, ''), line).not.toMatch(
          /[ß—–!"„“”'‚‘’]/,
        );
        expect(text, line).not.toMatch(/\d{4}/);
        expect(line.split('‹').length, line).toBe(line.split('›').length);
      }
    },
  );

  it.each([
    ...Object.entries(auditShowProblemTexts),
    ...Object.entries(auditFolderTexts),
    ['log', logUnreadableText],
  ])('say in %s what happened, why and what to do', (_, text) => {
    const sentences = text.split(/(?<=\.) /);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-ZÄÖÜ‹«].*\.$/);
    }
  });
});
