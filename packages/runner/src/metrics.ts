/**
 * The metrics file of the runner (ADR 0033, ADR 0028): per routine when
 * the runner looks at it again, when its last run that did its work ended
 * and the status of its last run, and the head of the chain of the audit
 * file, in the text format of Prometheus. A monitoring reads it; nothing
 * in the runner does, except to carry the values of the routines a call
 * did not run into the next file.
 *
 * Where it stands: after a pass. This module only renders, reads and
 * merges the text; the composition root reads and replaces the file.
 *
 * Why own code and no library: four gauges and a closed set of labels do
 * not need one, and the text stays under our control (decided on
 * 10.11.2026). Why no time per sample: the textfile collector of
 * node_exporter refuses one, so the times are values in Unix seconds.
 *
 * Why a strict reader: the file lies where the operator chose. A file
 * that is not exactly one this module wrote counts as none, so that no
 * line from elsewhere reaches the next file and the file never decides
 * about a run.
 *
 * @packageDocumentation
 */
import { isAuditFileName, isSha256 } from '@ecclium/mcp-churchtools-core';

import type { RoutineReport } from './pass.js';

/**
 * Every status of the last run of a routine, frozen: how a run ended, that
 * the routine does not start (`refused`), or why its run did not begin.
 */
export const metricStatuses = Object.freeze([
  'written',
  'unchanged',
  'queued',
  'drafted',
  'failed',
  'refused',
  'halted',
  'read_only',
  'unavailable',
  'lock_failed',
  'not_opened',
  'internal',
] as const);

/** A status of the last run of a routine. */
export type MetricStatus = (typeof metricStatuses)[number];

/** What the metrics file says of one routine. */
export interface RoutineMetrics {
  /** The ID of the routine. */
  readonly routineId: string;
  /**
   * When the runner looks at the routine again, in milliseconds since the
   * Unix epoch: its next trigger or the time of its next try.
   */
  readonly nextRun?: number;
  /**
   * When its last run ended that wrote, changed nothing, queued its write
   * or wrote a draft, in milliseconds since the Unix epoch.
   */
  readonly lastSuccess?: number;
  /** The status of its last run, or why it did not run. */
  readonly lastStatus?: MetricStatus;
  /**
   * The code of a failed run, of a routine that does not start or of a
   * run that could not be opened.
   */
  readonly code?: string;
}

/** The head of the chain of an audit file (ADR 0028). */
export interface MetricsChainHead {
  /** The name of the file, without the folder. */
  readonly file: string;
  /** The seq of its last whole line. */
  readonly seq: number;
  /** The SHA-256 of its last whole line, in hex. */
  readonly hash: string;
}

/** What the metrics file says. */
export interface RunnerMetrics {
  /** The routines, in the order of their IDs. */
  readonly routines: readonly RoutineMetrics[];
  /** The last head of the chain of an audit file the runner knows. */
  readonly chain?: MetricsChainHead;
}

/** What one update of the metrics file takes. */
export interface MetricsUpdate {
  /** The metrics of the last file, or undefined when there was none. */
  readonly previous: RunnerMetrics | undefined;
  /**
   * Every routine the runner loaded, also those that do not start. A
   * routine of the last file that is not among them is dropped.
   */
  readonly routineIds: readonly string[];
  /** The routines that do not start, with their codes. */
  readonly refused: readonly {
    readonly routineId: string;
    readonly code: string;
  }[];
  /** What became of the routines of this pass or call. */
  readonly reports: readonly RoutineReport[];
  /** When the runner looks at each routine again, by ID. */
  readonly next: ReadonlyMap<string, number>;
  /** The head of the chain of the audit file, when known. */
  readonly chain: MetricsChainHead | undefined;
}

// The ID of a routine, as its schema takes it.
const routinePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A code of the core, of the engine or of the start, in snake case.
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;
// The largest time a line carries: the end of the year 9999 in seconds,
// so that every value stays a safe integer in milliseconds.
const maxSeconds = 253_402_300_799;

const names = Object.freeze({
  next: 'ecclium_runner_next_run_timestamp_seconds',
  success: 'ecclium_runner_last_success_timestamp_seconds',
  status: 'ecclium_runner_last_status',
  chain: 'ecclium_runner_audit_chain_head',
});

const helps = Object.freeze({
  next: 'Zeit, zu der der Runner die Routine wieder ansieht, in Sekunden seit 1970.',
  success:
    'Ende des letzten Laufs der Routine, der geschrieben, nichts geändert, eingereiht oder einen Entwurf geschrieben hat, in Sekunden seit 1970.',
  status:
    'Status des letzten Laufs der Routine oder warum sie nicht lief, im Label status, mit dem Wert 1.',
  chain:
    'Nummer der letzten ganzen Zeile der Audit-Datei, mit dem Namen der Datei und dem SHA-256 der Zeile.',
});

const isRoutineId = (value: string): boolean => routinePattern.test(value);

const isCode = (value: string): boolean => codePattern.test(value);

const isTime = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= maxSeconds * 1000;

const secondsOf = (time: number): string => String(Math.floor(time / 1000));

const head = (key: keyof typeof names): readonly string[] => [
  `# HELP ${names[key]} ${helps[key]}`,
  `# TYPE ${names[key]} gauge`,
];

const invalid = (): never => {
  throw new TypeError('The metrics of the runner do not fit their form.');
};

/**
 * Renders the metrics in the text format of Prometheus, every gauge with
 * its help and type, also without a sample, and a line break at the end.
 *
 * @param metrics - The metrics, with the routines in the order of their
 *   IDs.
 * @returns The text of the file.
 * @throws {TypeError} When an ID, a code, a status, a time or the head of
 *   the chain does not fit its form, or the routines are not in order.
 * @example
 * ```ts
 * renderRunnerMetrics({ routines: [{ routineId: 'weekly', nextRun: 1_763_355_600_000 }] });
 * ```
 */
export function renderRunnerMetrics(metrics: RunnerMetrics): string {
  let last = '';
  for (const routine of metrics.routines) {
    const { routineId, nextRun, lastSuccess, lastStatus, code } = routine;
    if (
      !isRoutineId(routineId) ||
      routineId <= last ||
      (nextRun !== undefined && !isTime(nextRun)) ||
      (lastSuccess !== undefined && !isTime(lastSuccess)) ||
      (lastStatus !== undefined && !metricStatuses.includes(lastStatus)) ||
      (code !== undefined && (lastStatus === undefined || !isCode(code)))
    ) {
      invalid();
    }
    last = routineId;
  }
  const { chain } = metrics;
  if (
    chain !== undefined &&
    (!isAuditFileName(chain.file) ||
      !isSha256(chain.hash) ||
      !Number.isSafeInteger(chain.seq) ||
      chain.seq < 1)
  ) {
    invalid();
  }
  const label = (routineId: string): string => `routine="${routineId}"`;
  const lines = [
    ...head('next'),
    ...metrics.routines.flatMap(({ routineId, nextRun }) =>
      nextRun === undefined
        ? []
        : [`${names.next}{${label(routineId)}} ${secondsOf(nextRun)}`],
    ),
    ...head('success'),
    ...metrics.routines.flatMap(({ routineId, lastSuccess }) =>
      lastSuccess === undefined
        ? []
        : [`${names.success}{${label(routineId)}} ${secondsOf(lastSuccess)}`],
    ),
    ...head('status'),
    ...metrics.routines.flatMap(({ routineId, lastStatus, code }) =>
      lastStatus === undefined
        ? []
        : [
            `${names.status}{${label(routineId)},status="${lastStatus}"${
              code === undefined ? '' : `,code="${code}"`
            }} 1`,
          ],
    ),
    ...head('chain'),
    ...(chain === undefined
      ? []
      : [
          `${names.chain}{file="${chain.file}",hash="${chain.hash}"} ${String(chain.seq)}`,
        ]),
  ];
  return `${lines.join('\n')}\n`;
}

// One sample line: a name, its labels and a whole number.
const samplePattern = /^(ecclium_runner_[a-z_]+)\{([^{}\n]*)\} (\d{1,16})$/;
// One label: a name and a value without quote, backslash or line break.
const labelPattern = /^([a-z]+)="([^"\\\n]*)"$/;

/**
 * Reads a metrics file, strictly: only a text exactly as
 * {@link renderRunnerMetrics} writes it counts.
 *
 * @param text - The text of the file.
 * @returns The metrics, frozen, or undefined for any other text.
 * @example
 * ```ts
 * const previous = readRunnerMetrics(text);
 * ```
 */
export function readRunnerMetrics(text: string): RunnerMetrics | undefined {
  if (!text.endsWith('\n')) return undefined;
  const byId = new Map<string, Record<string, unknown>>();
  const entry = (routineId: string): Record<string, unknown> => {
    let found = byId.get(routineId);
    if (found === undefined) {
      found = { routineId };
      byId.set(routineId, found);
    }
    return found;
  };
  let chain: MetricsChainHead | undefined;
  for (const line of text.slice(0, -1).split('\n')) {
    if (line.startsWith('# ')) continue;
    const sample = samplePattern.exec(line);
    if (sample === null) return undefined;
    const [, name = '', labelText = '', valueText = ''] = sample;
    const labels = new Map<string, string>();
    for (const part of labelText.split(',')) {
      const match = labelPattern.exec(part);
      if (match === null) return undefined;
      const [, key = '', given = ''] = match;
      labels.set(key, given);
    }
    const value = Number(valueText);
    const routineId = labels.get('routine');
    if (name === names.chain) {
      chain = {
        file: labels.get('file') ?? '',
        hash: labels.get('hash') ?? '',
        seq: value,
      };
    } else if (routineId === undefined) {
      return undefined;
    } else if (name === names.next) {
      entry(routineId)['nextRun'] = value * 1000;
    } else if (name === names.success) {
      entry(routineId)['lastSuccess'] = value * 1000;
    } else if (name === names.status) {
      const found = entry(routineId);
      found['lastStatus'] = labels.get('status');
      const code = labels.get('code');
      if (code !== undefined) found['code'] = code;
    } else {
      return undefined;
    }
  }
  const metrics: RunnerMetrics = {
    routines: [...byId.values()]
      .map((routine) => Object.freeze(routine as unknown as RoutineMetrics))
      .sort((left, right) => (left.routineId < right.routineId ? -1 : 1)),
    ...(chain === undefined ? {} : { chain: Object.freeze(chain) }),
  };
  // Rendered again, the text must come back byte for byte: so a line
  // twice, a label in another order, a help of another text or a value
  // out of range all count as another file.
  try {
    if (renderRunnerMetrics(metrics) !== text) return undefined;
  } catch {
    return undefined;
  }
  return Object.freeze({
    ...metrics,
    routines: Object.freeze(metrics.routines),
  });
}

// What a report of a pass says for the metrics: a status, its code, and
// whether the run did its work; nothing for a routine that was not due,
// held by another process, stopped or only previewed.
const statusOf = (
  report: RoutineReport,
):
  | {
      readonly status: MetricStatus;
      readonly code?: string;
      readonly success: boolean;
    }
  | undefined => {
  switch (report.status) {
    case 'ran': {
      const { outcome } = report;
      if (outcome === undefined || outcome.result === 'preview') {
        return undefined;
      }
      return outcome.result === 'failed'
        ? {
            status: 'failed',
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            success: false,
          }
        : { status: outcome.result, success: true };
    }
    case 'not_due':
    case 'busy':
    case 'stopped':
      return undefined;
    case 'not_opened':
      return {
        status: 'not_opened',
        ...(report.code === undefined ? {} : { code: report.code }),
        success: false,
      };
    default:
      return { status: report.status, success: false };
  }
};

/**
 * Merges what a pass or a call found into the metrics of the last file:
 * the next times of every routine it knows, the status of each routine it
 * ran or could not run, `refused` for each routine that does not start,
 * and the head of the chain. A routine it did not run keeps its last
 * success and status; one that is no longer loaded is dropped.
 *
 * @param update - The last metrics, the routines, the reports, the next
 *   times and the head of the chain.
 * @returns The new metrics, frozen. A code that does not fit the form of a
 *   code and a time that is no time are left out.
 * @example
 * ```ts
 * const metrics = updateRunnerMetrics({ previous, routineIds, refused, reports: pass.routines, next, chain });
 * ```
 */
export function updateRunnerMetrics(update: MetricsUpdate): RunnerMetrics {
  const previous = new Map(
    (update.previous?.routines ?? []).map((routine) => [
      routine.routineId,
      routine,
    ]),
  );
  const refused = new Map(
    update.refused.map((item) => [item.routineId, item.code]),
  );
  const reports = new Map(
    update.reports.map((report) => [report.routineId, report]),
  );
  const ids = [...new Set(update.routineIds)]
    .filter(isRoutineId)
    .sort((left, right) => (left < right ? -1 : 1));
  const routines = ids.map((routineId): RoutineMetrics => {
    const before = previous.get(routineId);
    let lastSuccess = before?.lastSuccess;
    let lastStatus = before?.lastStatus;
    let code = before?.code;
    const refusedCode = refused.get(routineId);
    const report = reports.get(routineId);
    const found = report === undefined ? undefined : statusOf(report);
    if (refusedCode !== undefined) {
      lastStatus = 'refused';
      code = refusedCode;
    } else if (found !== undefined) {
      lastStatus = found.status;
      code = found.code;
      if (found.success && report?.endedAt !== undefined) {
        lastSuccess = report.endedAt;
      }
    }
    const nextRun = update.next.get(routineId);
    return Object.freeze({
      routineId,
      ...(nextRun === undefined || !isTime(nextRun) ? {} : { nextRun }),
      ...(lastSuccess === undefined || !isTime(lastSuccess)
        ? {}
        : { lastSuccess }),
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(lastStatus === undefined || code === undefined || !isCode(code)
        ? {}
        : { code }),
    });
  });
  const chain = update.chain ?? update.previous?.chain;
  return Object.freeze({
    routines: Object.freeze(routines),
    ...(chain === undefined
      ? {}
      : {
          chain: Object.freeze({
            file: chain.file,
            seq: chain.seq,
            hash: chain.hash,
          }),
        }),
  });
}
