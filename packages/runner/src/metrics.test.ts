import { describe, expect, it } from 'vitest';

import {
  metricStatuses,
  readRunnerMetrics,
  renderRunnerMetrics,
  type RunnerMetrics,
  updateRunnerMetrics,
} from './metrics.js';
import type { RoutineReport } from './pass.js';

const file = 'audit-2026-11-11-200000-4242-1.jsonl';
const hash = 'a'.repeat(64);
const second = 1_000;
const next = 1_763_355_600 * second;
const success = 1_762_750_812 * second;

const help = {
  next: [
    '# HELP ecclium_runner_next_run_timestamp_seconds Zeit, zu der der Runner die Routine wieder ansieht, in Sekunden seit 1970.',
    '# TYPE ecclium_runner_next_run_timestamp_seconds gauge',
  ],
  success: [
    '# HELP ecclium_runner_last_success_timestamp_seconds Ende des letzten Laufs der Routine, der geschrieben, nichts geändert, eingereiht oder einen Entwurf geschrieben hat, in Sekunden seit 1970.',
    '# TYPE ecclium_runner_last_success_timestamp_seconds gauge',
  ],
  status: [
    '# HELP ecclium_runner_last_status Status des letzten Laufs der Routine oder warum sie nicht lief, im Label status, mit dem Wert 1.',
    '# TYPE ecclium_runner_last_status gauge',
  ],
  chain: [
    '# HELP ecclium_runner_audit_chain_head Nummer der letzten ganzen Zeile der Audit-Datei, mit dem Namen der Datei und dem SHA-256 der Zeile.',
    '# TYPE ecclium_runner_audit_chain_head gauge',
  ],
};

const full: RunnerMetrics = {
  routines: [
    {
      routineId: 'dienstplan-report',
      nextRun: next,
      lastSuccess: success,
      lastStatus: 'written',
    },
    { routineId: 'termin-vorschau', nextRun: next + 900 * second },
    {
      routineId: 'wiki-hygiene',
      lastStatus: 'refused',
      code: 'run_target_unlisted',
    },
  ],
  chain: { file, seq: 42, hash },
};

const fullText = [
  ...help.next,
  'ecclium_runner_next_run_timestamp_seconds{routine="dienstplan-report"} 1763355600',
  'ecclium_runner_next_run_timestamp_seconds{routine="termin-vorschau"} 1763356500',
  ...help.success,
  'ecclium_runner_last_success_timestamp_seconds{routine="dienstplan-report"} 1762750812',
  ...help.status,
  'ecclium_runner_last_status{routine="dienstplan-report",status="written"} 1',
  'ecclium_runner_last_status{routine="wiki-hygiene",status="refused",code="run_target_unlisted"} 1',
  ...help.chain,
  `ecclium_runner_audit_chain_head{file="${file}",hash="${hash}"} 42`,
  '',
].join('\n');

const emptyText = [
  ...help.next,
  ...help.success,
  ...help.status,
  ...help.chain,
  '',
].join('\n');

describe('renderRunnerMetrics', () => {
  it('writes every gauge with its help and type and a line per value, times in whole seconds', () => {
    expect(renderRunnerMetrics(full)).toBe(fullText);
    expect(
      renderRunnerMetrics({
        routines: [{ routineId: 'weekly', nextRun: next + 999 }],
      }),
    ).toContain(
      'ecclium_runner_next_run_timestamp_seconds{routine="weekly"} 1763355600\n',
    );
  });

  it('writes the help and type of every gauge also without a value', () => {
    expect(renderRunnerMetrics({ routines: [] })).toBe(emptyText);
    expect(renderRunnerMetrics({ routines: [{ routineId: 'weekly' }] })).toBe(
      emptyText,
    );
  });

  it.each<[string, RunnerMetrics]>([
    ['an ID out of form', { routines: [{ routineId: 'Weekly' }] }],
    [
      'an ID with a quote',
      { routines: [{ routineId: 'weekly"} 1\nevil{a="' }] },
    ],
    [
      'routines out of order',
      { routines: [{ routineId: 'b' }, { routineId: 'a' }] },
    ],
    ['a routine twice', { routines: [{ routineId: 'a' }, { routineId: 'a' }] }],
    ['a time below 0', { routines: [{ routineId: 'a', nextRun: -1 }] }],
    ['a time not whole', { routines: [{ routineId: 'a', nextRun: 0.5 }] }],
    [
      'a time past the year 9999',
      { routines: [{ routineId: 'a', lastSuccess: 253_402_300_800_000 }] },
    ],
    [
      'an unknown status',
      {
        routines: [
          {
            routineId: 'a',
            lastStatus: 'preview' as unknown as 'written',
          },
        ],
      },
    ],
    ['a code without a status', { routines: [{ routineId: 'a', code: 'x' }] }],
    [
      'a code out of form',
      {
        routines: [
          { routineId: 'a', lastStatus: 'failed', code: 'Bad "code"' },
        ],
      },
    ],
    [
      'a chain with another file name',
      { routines: [], chain: { file: '../audit.jsonl', seq: 1, hash } },
    ],
    [
      'a chain with another hash',
      { routines: [], chain: { file, seq: 1, hash: 'A'.repeat(64) } },
    ],
    ['a chain at seq 0', { routines: [], chain: { file, seq: 0, hash } }],
    [
      'a chain with a seq that is no integer',
      { routines: [], chain: { file, seq: 1.5, hash } },
    ],
  ])('refuses %s', (_case, metrics) => {
    expect(() => renderRunnerMetrics(metrics)).toThrow(TypeError);
  });
});

describe('readRunnerMetrics', () => {
  it('reads back exactly what it wrote', () => {
    const read = readRunnerMetrics(fullText);
    expect(read).toEqual(full);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read?.routines)).toBe(true);
    expect(Object.isFrozen(read?.routines[0])).toBe(true);
    expect(Object.isFrozen(read?.chain)).toBe(true);
    expect(readRunnerMetrics(emptyText)).toEqual({ routines: [] });
  });

  it('reads routines back in the order of their IDs, whichever gauge names them first', () => {
    const metrics: RunnerMetrics = {
      routines: [
        { routineId: 'a', lastSuccess: success },
        { routineId: 'b', nextRun: next },
        { routineId: 'c', lastStatus: 'halted' },
      ],
    };
    expect(readRunnerMetrics(renderRunnerMetrics(metrics))).toEqual(metrics);
  });

  it.each<[string, string]>([
    ['an empty text', ''],
    ['a text without its last line break', fullText.slice(0, -1)],
    ['a line twice', `${fullText}${fullText.split('\n')[2] ?? ''}\n`],
    ['another help', fullText.replace('Zeit, zu der', 'Wann')],
    [
      'a sample of another gauge',
      fullText.replace(
        'ecclium_runner_last_success_timestamp_seconds{',
        'ecclium_runner_other_seconds{',
      ),
    ],
    [
      'a line of another program',
      `${emptyText}node_cpu_seconds_total{cpu="0"} 1\n`,
    ],
    [
      'labels in another order',
      fullText.replace(
        `{file="${file}",hash="${hash}"}`,
        `{hash="${hash}",file="${file}"}`,
      ),
    ],
    [
      'a label with an escape',
      fullText.replace('routine="termin-vorschau"', 'routine="termin\\"x"'),
    ],
    [
      'a sample without a routine',
      emptyText.replace(
        help.next[1] ?? '',
        `${help.next[1] ?? ''}\necclium_runner_next_run_timestamp_seconds{job="a"} 1`,
      ),
    ],
    [
      'a value with a fraction',
      fullText.replace('} 1763355600', '} 1763355600.5'),
    ],
    [
      'a value past the year 9999',
      fullText.replace('} 1763355600', '} 9999999999999999'),
    ],
    [
      'an unknown status',
      fullText.replace('status="written"', 'status="exploded"'),
    ],
    ['a chain without its hash', fullText.replace(`,hash="${hash}"`, '')],
    ['a chain without its file', fullText.replace(`file="${file}",`, '')],
    [
      'a line with a time per sample',
      fullText.replace('} 42\n', '} 42 1763355600000\n'),
    ],
    ['a carriage return', fullText.replace('\n', '\r\n')],
    ['lines in another order', fullText.split('\n').reverse().join('\n')],
  ])('counts %s as no file of its own', (_case, text) => {
    expect(readRunnerMetrics(text)).toBeUndefined();
  });
});

const report = (
  routineId: string,
  over: Partial<RoutineReport> = {},
): RoutineReport => ({
  routineId,
  status: 'ran',
  severity: 'ok',
  ...over,
});

describe('updateRunnerMetrics', () => {
  const base = {
    previous: undefined,
    routineIds: [],
    refused: [],
    reports: [],
    next: new Map<string, number>(),
    chain: undefined,
  };

  it('writes the status and the end of a run that did its work, for each result', () => {
    for (const result of [
      'written',
      'unchanged',
      'queued',
      'drafted',
    ] as const) {
      const metrics = updateRunnerMetrics({
        ...base,
        routineIds: ['weekly'],
        reports: [
          report('weekly', {
            outcome: { result, final: true },
            endedAt: success,
          }),
        ],
        next: new Map([['weekly', next]]),
      });
      expect(metrics).toEqual({
        routines: [
          {
            routineId: 'weekly',
            nextRun: next,
            lastSuccess: success,
            lastStatus: result,
          },
        ],
      });
      expect(Object.isFrozen(metrics)).toBe(true);
      expect(Object.isFrozen(metrics.routines)).toBe(true);
      expect(Object.isFrozen(metrics.routines[0])).toBe(true);
    }
  });

  it('keeps the last success after a failed run and names its code', () => {
    const metrics = updateRunnerMetrics({
      ...base,
      previous: {
        routines: [
          { routineId: 'weekly', lastSuccess: success, lastStatus: 'written' },
        ],
      },
      routineIds: ['weekly'],
      reports: [
        report('weekly', {
          severity: 'temporary',
          outcome: {
            result: 'failed',
            step: 'model',
            code: 'network',
            final: false,
          },
          endedAt: success + 7 * 86_400_000,
        }),
      ],
    });
    expect(metrics.routines).toEqual([
      {
        routineId: 'weekly',
        lastSuccess: success,
        lastStatus: 'failed',
        code: 'network',
      },
    ]);
    // A failure without a code has none.
    expect(
      updateRunnerMetrics({
        ...base,
        routineIds: ['weekly'],
        reports: [
          report('weekly', {
            outcome: { result: 'failed', final: true },
          }),
        ],
      }).routines,
    ).toEqual([{ routineId: 'weekly', lastStatus: 'failed' }]);
  });

  it('takes no end for a run that did its work without one', () => {
    expect(
      updateRunnerMetrics({
        ...base,
        routineIds: ['weekly'],
        reports: [
          report('weekly', { outcome: { result: 'written', final: true } }),
        ],
      }).routines,
    ).toEqual([{ routineId: 'weekly', lastStatus: 'written' }]);
  });

  it('names why a run did not begin, with the code of a run that was not opened', () => {
    const statuses = [
      'halted',
      'read_only',
      'unavailable',
      'lock_failed',
      'internal',
    ] as const;
    const metrics = updateRunnerMetrics({
      ...base,
      routineIds: [...statuses.map((status) => status.replace('_', '-')), 'z'],
      reports: [
        ...statuses.map((status) =>
          report(status.replace('_', '-'), { status }),
        ),
        report('z', { status: 'not_opened', code: 'token_file_missing' }),
      ],
    });
    expect(metrics.routines).toEqual([
      { routineId: 'halted', lastStatus: 'halted' },
      { routineId: 'internal', lastStatus: 'internal' },
      { routineId: 'lock-failed', lastStatus: 'lock_failed' },
      { routineId: 'read-only', lastStatus: 'read_only' },
      { routineId: 'unavailable', lastStatus: 'unavailable' },
      { routineId: 'z', lastStatus: 'not_opened', code: 'token_file_missing' },
    ]);
    expect(
      updateRunnerMetrics({
        ...base,
        routineIds: ['z'],
        reports: [report('z', { status: 'not_opened' })],
      }).routines,
    ).toEqual([{ routineId: 'z', lastStatus: 'not_opened' }]);
  });

  it('keeps the last status of a routine that was not due, held elsewhere, stopped or only previewed', () => {
    const previous: RunnerMetrics = {
      routines: ['a', 'b', 'c', 'd', 'e'].map((routineId) => ({
        routineId,
        lastSuccess: success,
        lastStatus: 'failed' as const,
        code: 'network',
      })),
    };
    const metrics = updateRunnerMetrics({
      ...base,
      previous,
      routineIds: ['a', 'b', 'c', 'd', 'e'],
      reports: [
        report('a', { status: 'not_due' }),
        report('b', { status: 'busy' }),
        report('c', { status: 'stopped' }),
        report('d', { outcome: { result: 'preview', final: true } }),
        report('e'),
      ],
    });
    expect(metrics.routines).toEqual(previous.routines);
  });

  it('marks a routine that does not start as refused and keeps its last success', () => {
    const metrics = updateRunnerMetrics({
      ...base,
      previous: {
        routines: [
          { routineId: 'weekly', lastSuccess: success, lastStatus: 'written' },
        ],
      },
      routineIds: ['weekly'],
      refused: [{ routineId: 'weekly', code: 'run_target_unlisted' }],
      reports: [
        report('weekly', { outcome: { result: 'written', final: true } }),
      ],
    });
    expect(metrics.routines).toEqual([
      {
        routineId: 'weekly',
        lastSuccess: success,
        lastStatus: 'refused',
        code: 'run_target_unlisted',
      },
    ]);
  });

  it('carries the values of the routines a call did not run and drops those no longer loaded', () => {
    const metrics = updateRunnerMetrics({
      ...base,
      previous: {
        routines: [
          { routineId: 'gone', lastStatus: 'written', nextRun: next },
          {
            routineId: 'other',
            lastSuccess: success,
            lastStatus: 'drafted',
            nextRun: next,
          },
        ],
        chain: { file, seq: 7, hash },
      },
      routineIds: ['weekly', 'other', 'weekly'],
      reports: [],
      next: new Map([
        ['other', next + second],
        ['weekly', next + 2 * second],
      ]),
    });
    expect(metrics).toEqual({
      routines: [
        {
          routineId: 'other',
          nextRun: next + second,
          lastSuccess: success,
          lastStatus: 'drafted',
        },
        { routineId: 'weekly', nextRun: next + 2 * second },
      ],
      chain: { file, seq: 7, hash },
    });
  });

  it('takes the new head of the chain, only its three fields', () => {
    const metrics = updateRunnerMetrics({
      ...base,
      previous: { routines: [], chain: { file, seq: 7, hash } },
      chain: { file, seq: 9, hash: 'b'.repeat(64), final: true } as never,
    });
    expect(metrics.chain).toEqual({ file, seq: 9, hash: 'b'.repeat(64) });
    expect(Object.isFrozen(metrics.chain)).toBe(true);
  });

  it('leaves out an ID, a code or a time out of form, so that the file can still be written', () => {
    const metrics = updateRunnerMetrics({
      ...base,
      previous: {
        routines: [{ routineId: 'weekly', lastSuccess: -5 }],
      },
      routineIds: ['Bad ID', 'weekly'],
      refused: [{ routineId: 'weekly', code: 'Not a code' }],
      next: new Map([['weekly', Number.NaN]]),
    });
    expect(metrics.routines).toEqual([
      { routineId: 'weekly', lastStatus: 'refused' },
    ]);
    expect(() => renderRunnerMetrics(metrics)).not.toThrow();
  });

  it('renders every status it can give', () => {
    const routines = metricStatuses.map((lastStatus, index) => ({
      routineId: `r${String(index).padStart(2, '0')}`,
      lastStatus,
    }));
    const text = renderRunnerMetrics({ routines });
    expect(readRunnerMetrics(text)).toEqual({ routines });
  });
});
