import {
  checkProviders,
  type ProviderSettings,
} from '@ecclium/mcp-churchtools-core';
import type {
  PreviewReport,
  RoutineReport,
  RoutineStatus,
} from '@ecclium/mcp-churchtools-runner';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { runPrepareCodes } from '@ecclium/mcp-churchtools-workflows';
import { describe, expect, it } from 'vitest';

import type { RunnerRoutineCode } from './start.js';
import {
  daemonStartText,
  draftsFolderText,
  metricsFolderText,
  passSummaryText,
  previewReportText,
  providerText,
  refusedText,
  routineReportText,
  routinesProblemText,
  runnerProcessTexts,
  runnerStartTexts,
} from './texts.js';

// The German texts of the runner: one for every code a routine does not
// start with, none that names a path, and the fixed forms of the lines of
// a pass. All data are made up.

// Every code a single routine does not start with. A new code of the type
// breaks the build here until it is listed.
const routineCodes = Object.keys({
  run_tool_unknown: true,
  run_tool_unfit: true,
  run_param_unknown: true,
  run_param_days: true,
  run_field_unknown: true,
  run_credential_mixed: true,
  run_target_unlisted: true,
  run_model_unknown: true,
  runner_drafts_dir_unset: true,
  runner_stop_dir_missing: true,
  runner_inquiries_missing: true,
  runner_pseudonym_key_missing: true,
  runner_notify_file_unset: true,
} satisfies Record<RunnerRoutineCode, true>) as RunnerRoutineCode[];

// Every status of a routine in a pass, likewise.
const statuses = Object.keys({
  ran: true,
  not_due: true,
  busy: true,
  halted: true,
  read_only: true,
  unavailable: true,
  lock_failed: true,
  not_opened: true,
  stopped: true,
  internal: true,
} satisfies Record<RoutineStatus, true>) as RoutineStatus[];

const routineId = 'dienstplan-report';

// A key file and an endpoint whose names hold a canary, so that a text
// that names either would show.
const pathCanary = makeCanary('token').cores[0] ?? '';
const providersOf = (
  ...entries: Record<string, unknown>[]
): readonly ProviderSettings[] => {
  const checked = checkProviders({
    schema: 'providers.v1',
    providers: entries.map((entry) => ({
      alias: 'default',
      vendor: 'example',
      model: 'example-model-1',
      hostingCountry: 'CH',
      endpoint: `https://model.example.org/${pathCanary}/v1/chat/completions`,
      structuredOutput: true,
      apiKeyFile: `/path/to/${pathCanary}/model-key`,
      ...entry,
    })),
  });
  if (!checked.ok) throw new Error('the providers of the test are invalid');
  return checked.providers;
};

// A report of every status, with every field a text may name.
const reportOf = (
  status: RoutineStatus,
  more: Partial<RoutineReport> = {},
): RoutineReport => ({
  routineId,
  status,
  severity: 'ok',
  period: '2026-W46',
  ...more,
});

// Every text of the runner, with codes, statuses and values as the
// runner gives them.
const everyText = (): string[] => [
  runnerStartTexts.credential_mixed(routineId),
  runnerStartTexts.read_only_wiki(routineId),
  runnerStartTexts.routine_unknown,
  runnerStartTexts.routine_invalid,
  routinesProblemText({
    code: 'routine_yaml_syntax',
    routine: routineId,
    field: 'generate.prompt',
    line: 4,
    reason: 'symlink',
  }),
  ...routineCodes.map((code) =>
    refusedText({ routineId, code, field: 'inputs[0].tool' }),
  ),
  ...statuses.flatMap((status) => {
    const text = routineReportText(
      reportOf(status, {
        code: 'token_file_missing',
        runId: '11111111-2222-4333-8444-555555555555',
        outcome: {
          result: 'failed',
          step: 'input',
          code: 'upstream',
          final: false,
        },
        recorded: false,
        closed: false,
        notified: false,
      }),
    );
    return text === undefined ? [] : [text];
  }),
  ...(['ran', 'not_opened', 'internal'] as const).map((status) =>
    previewReportText({
      routineId,
      status,
      severity: 'ok',
      period: '2026-W46',
      code: 'token_file_missing',
      outcome: { result: 'preview', final: true },
      recorded: false,
    }),
  ),
  ...providersOf({}).map(providerText),
  passSummaryText({ ran: 2, skipped: 1, refused: 1 }),
];

describe('the texts of the runner', () => {
  it('have a text with the code for every code a routine does not start with', () => {
    expect(new Set(routineCodes)).toEqual(
      new Set([
        ...runPrepareCodes,
        'runner_pseudonym_key_missing',
        'runner_drafts_dir_unset',
        'runner_stop_dir_missing',
        'runner_inquiries_missing',
        'runner_notify_file_unset',
      ]),
    );
    const texts = routineCodes.map((code) => refusedText({ routineId, code }));
    for (const [index, code] of routineCodes.entries()) {
      const text = texts[index] ?? '';
      expect(
        text.startsWith(
          `Die Routine ‹${routineId}› startet nicht, Code ‹${code}›. `,
        ),
      ).toBe(true);
      // Something to do follows the code.
      expect(text.length).toBeGreaterThan(
        `Die Routine ‹${routineId}› startet nicht, Code ‹${code}›. `.length +
          20,
      );
      expect(text).not.toContain('undefined');
    }
    // Each code has an action of its own.
    expect(
      new Set(texts.map((text) => text.split('. ').slice(1).join('. '))).size,
    ).toBe(routineCodes.length);
  });

  it('names the field of a routine that does not start', () => {
    expect(
      refusedText({
        routineId,
        code: 'run_tool_unknown',
        field: 'inputs[1].tool',
      }),
    ).toBe(
      `Die Routine ‹${routineId}› startet nicht, Code ‹run_tool_unknown›, Feld ‹inputs[1].tool›. Das Tool gibt es in Ecclium nicht. Prüfen Sie den Namen des Tools.`,
    );
  });

  it('never name a path, and never the key file or the endpoint of a provider', () => {
    const texts = everyText();
    expect(texts.length).toBeGreaterThan(routineCodes.length + statuses.length);
    for (const text of texts) {
      expect(text).not.toContain(pathCanary);
      expect(text).not.toMatch(/(?:^|[\s‹«(])\/[^\s›»)]+/u);
      expect(text).not.toContain('model.example.org');
      expect(text).not.toContain('undefined');
    }
  });

  it('say nothing of a routine that was not due or not reached', () => {
    expect(routineReportText(reportOf('not_due'))).toBeUndefined();
    expect(routineReportText(reportOf('stopped'))).toBeUndefined();
    // Every other status has its line; a run has its outcome.
    const outcome = { result: 'written', final: true } as const;
    for (const status of statuses) {
      if (status === 'not_due' || status === 'stopped') continue;
      expect(routineReportText(reportOf(status, { outcome }))).toMatch(
        new RegExp(`^Routine ‹${routineId}›`, 'u'),
      );
    }
  });

  it('report a run with its period, its ID, how it ended and what was lost', () => {
    const runId = '11111111-2222-4333-8444-555555555555';
    expect(
      routineReportText(
        reportOf('ran', {
          runId,
          outcome: { result: 'written', final: true },
          recorded: true,
          closed: true,
          notified: true,
        }),
      ),
    ).toBe(
      `Routine ‹${routineId}›, Periode ‹2026-W46›, Lauf ‹${runId}›: geschrieben.`,
    );
    expect(
      routineReportText(
        reportOf('ran', {
          runId,
          outcome: {
            result: 'failed',
            step: 'input',
            code: 'upstream',
            final: false,
          },
          recorded: false,
          closed: true,
          notified: false,
        }),
      ),
    ).toBe(
      `Routine ‹${routineId}›, Periode ‹2026-W46›, Lauf ‹${runId}›: gescheitert, Code ‹upstream›. Ein späterer Aufruf versucht es noch einmal. Die Zeile des Audits zum Ende des Laufs erreichte die Audit-Datei nicht. Die Meldung des Laufs liess sich nicht ganz senden.`,
    );
    // After the third try no later call tries the trigger again (ADR 0034).
    expect(
      routineReportText(
        reportOf('ran', {
          runId,
          attempt: 3,
          outcome: {
            result: 'failed',
            step: 'input',
            code: 'upstream',
            final: false,
          },
          recorded: true,
          notified: true,
        }),
      ),
    ).toBe(
      `Routine ‹${routineId}›, Periode ‹2026-W46›, Lauf ‹${runId}›: gescheitert, Code ‹upstream›. Das war der dritte Versuch dieser Auslösung; die Routine wartet auf ihre nächste Auslösung, oder Sie starten sie mit ‹ecclium run-once <Routine>›.`,
    );
    expect(
      routineReportText(reportOf('not_opened', { code: 'token_file_mode' })),
    ).toContain('nicht gestartet, Code ‹token_file_mode›.');
  });

  it('report a preview on stderr, beside the section on stdout', () => {
    const shown: PreviewReport = {
      routineId,
      status: 'ran',
      severity: 'ok',
      period: '2026-W46',
      outcome: { result: 'preview', final: true },
      recorded: true,
    };
    expect(previewReportText(shown)).toBe(
      `Routine ‹${routineId}›, Periode ‹2026-W46›: Vorschau auf stdout, ohne die Zeile der Kennzeichnung. Geschrieben ist nichts, gezählt ist kein Versuch, aber das Lesen und, wo die Routine eines hat, das Modell haben gekostet.`,
    );
    expect(
      previewReportText({
        ...shown,
        outcome: {
          result: 'failed',
          step: 'answer',
          code: 'run_content_refused',
          final: true,
        },
      }),
    ).toBe(
      `Routine ‹${routineId}›, Periode ‹2026-W46›: Vorschau gescheitert, Code ‹run_content_refused›. Geschrieben ist nichts.`,
    );
  });

  it('name vendor, model and country of a provider in Switzerland or the EEA', () => {
    const [provider] = providersOf({});
    if (provider === undefined) throw new Error('no provider');
    expect(providerText(provider)).toBe(
      'Modell für ‹default›: Anbieter ‹example›, Modell ‹example-model-1›, Land ‹CH›, Schweiz oder EWR, keine Grundlage nötig.',
    );
  });

  it('name the basis of a transfer for a provider outside Switzerland and the EEA', () => {
    const [provider] = providersOf({
      alias: 'extern',
      hostingCountry: 'US',
      transferBasis: 'standard_contractual_clauses',
    });
    if (provider === undefined) throw new Error('no provider');
    expect(providerText(provider)).toBe(
      'Modell für ‹extern›: Anbieter ‹example›, Modell ‹example-model-1›, Land ‹US›, Grundlage ‹standard_contractual_clauses›.',
    );
  });

  it('count runs and routines in the last line of a pass, in the singular and the plural', () => {
    expect(passSummaryText({ ran: 1, skipped: 0, refused: 1 })).toBe(
      'Durchgang beendet: 1 Lauf, 0 übersprungen, 1 Routine startet nicht.',
    );
    expect(passSummaryText({ ran: 0, skipped: 2, refused: 0 })).toBe(
      'Durchgang beendet: 0 Läufe, 2 übersprungen, 0 Routinen starten nicht.',
    );
  });

  it('name the code of a folder of drafts or metrics that cannot be used, and say what to do', () => {
    expect(draftsFolderText('unsafe')).toContain('Code ‹unsafe›');
    expect(draftsFolderText('unsafe')).toContain('Rechten 700');
    expect(metricsFolderText('unavailable')).toContain('Code ‹unavailable›');
    expect(metricsFolderText('unavailable')).toContain(
      '‹ECCLIUM_RUNNER_METRICS_FILE›',
    );
    expect(metricsFolderText('unavailable')).toContain('derselbe Benutzer');
  });

  it('count the routines of the daemon at its start, in the singular and the plural', () => {
    expect(daemonStartText({ routines: 1, refused: 1 })).toBe(
      'Der Runner läuft mit 1 Routine, 1 startet nicht. Er sieht die Routinen zu ihrer Zeit an, spätestens alle 15 Minuten.',
    );
    expect(daemonStartText({ routines: 2, refused: 0 })).toBe(
      'Der Runner läuft mit 2 Routinen, 0 starten nicht. Er sieht die Routinen zu ihrer Zeit an, spätestens alle 15 Minuten.',
    );
  });

  it('say of a signal that a write that has begun still ends, and why the daemon ends with 75', () => {
    expect(runnerProcessTexts.signal).toContain(
      'ein Schreibvorgang, der begonnen hat, endet noch',
    );
    expect(runnerProcessTexts.halted).toContain(
      'Ein Neustart hebt die Sperre.',
    );
    for (const text of Object.values(runnerProcessTexts)) {
      expect(text).not.toMatch(/\/(?:data|srv|home|Users)\//u);
    }
  });
});
