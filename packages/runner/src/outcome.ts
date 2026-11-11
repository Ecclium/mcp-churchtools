/**
 * How a run of a routine ended, for its audit line, its notice and the
 * exit code of the command line (ADR 0033, ADR 0034).
 *
 * Where it stands in a run: at its end, after the write or the step that
 * failed. The engine and the write name a failure with codes of their own,
 * such as `run_content_refused`; the audit takes only the closed list of
 * error codes, and a whole pass ends with one exit code after sysexits.
 * Both come from here, so that `ecclium run-once` and the daemon judge a
 * run the same way.
 *
 * @packageDocumentation
 */
import {
  type AuditRunResult,
  type AuditRunStep,
  type ContentViolationKind,
  type ErrorCode,
  errorCodes,
} from '@ecclium/mcp-churchtools-plugin-api';

/** How a run ended, as the runner judges it. */
export interface RunOutcome {
  /** Written, unchanged, queued, drafted, a preview, or failed. */
  readonly result: AuditRunResult;
  /** The step a failed run ended in. */
  readonly step?: AuditRunStep;
  /**
   * The code of a failed run: one of the core, such as `policy_denied`, or
   * one of the engine, such as `run_content_refused`.
   */
  readonly code?: string;
  /**
   * Whether a new try would end the same. A final outcome closes the
   * trigger; every outcome but a failure is final.
   */
  readonly final: boolean;
  /** Why the content policy refused. */
  readonly violations?: readonly ContentViolationKind[];
  /** Whether a failure lies in a file of the runner, such as a draft. */
  readonly file?: boolean;
}

/** What the audit line of the end of a run says about how it ended. */
export interface RunAuditEnd {
  readonly result: AuditRunResult;
  readonly step?: AuditRunStep;
  /** The code of a failed run, from the closed list of the audit. */
  readonly code?: ErrorCode;
  /**
   * Whether the policy, a kill switch or the content policy refused the
   * run, so that its line says `denied` rather than `error`.
   */
  readonly refused?: boolean;
  /** Why the content policy refused, only with `refused`. */
  readonly contentViolations?: readonly ContentViolationKind[];
}

/**
 * The severities of the end of a run or a pass, from none to the worst,
 * frozen. The command line turns each into an exit code after sysexits:
 * `ok` 0, `temporary` 75, `file` 74, `data` 65, `refused` 77, `config` 78
 * and `internal` 70.
 */
export const runnerSeverities = Object.freeze([
  'ok',
  'temporary',
  'file',
  'data',
  'refused',
  'config',
  'internal',
] as const);

/** A severity of the end of a run or a pass. */
export type RunnerSeverity = (typeof runnerSeverities)[number];

/**
 * The worse of two severities.
 *
 * @param left - A severity.
 * @param right - Another severity.
 * @returns The one later in {@link runnerSeverities}.
 * @example
 * ```ts
 * worseOf('temporary', 'refused'); // 'refused'
 * ```
 */
export function worseOf(
  left: RunnerSeverity,
  right: RunnerSeverity,
): RunnerSeverity {
  return runnerSeverities.indexOf(left) >= runnerSeverities.indexOf(right)
    ? left
    : right;
}

// The codes of the engine, which say that the data or the answer of the
// model did not fit: limits of the reads, a person who is not one of the
// data, a breach of the content policy.
const engineCodes: readonly string[] = Object.freeze([
  'run_calls_exhausted',
  'run_items_exhausted',
  'run_person_unknown',
  'run_content_refused',
]);

const isErrorCode = (code: string): code is ErrorCode =>
  (errorCodes as readonly string[]).includes(code);

/**
 * The end of a run as its audit line states it. A code of the engine
 * becomes `validation`; a breach of the content policy and a final
 * `policy_denied`, which a kill switch or the policy gives, are refused
 * and say `denied`. A `policy_denied` that a later try may pass, such as
 * an audit file that took no line, is an error. A code the runner does not
 * know is `internal`.
 *
 * @param outcome - How the run ended.
 * @returns What its audit line says, frozen.
 * @example
 * ```ts
 * auditEndOf({ result: 'failed', step: 'content', code: 'run_content_refused', final: true });
 * // { result: 'failed', step: 'content', code: 'validation', refused: true }
 * ```
 */
export function auditEndOf(outcome: RunOutcome): RunAuditEnd {
  if (outcome.result !== 'failed') {
    return Object.freeze({ result: outcome.result });
  }
  const raw = outcome.code ?? 'internal';
  const code: ErrorCode = isErrorCode(raw)
    ? raw
    : engineCodes.includes(raw)
      ? 'validation'
      : 'internal';
  const refused =
    raw === 'run_content_refused' || (raw === 'policy_denied' && outcome.final);
  const violations = outcome.violations ?? [];
  return Object.freeze({
    result: 'failed',
    ...(outcome.step === undefined ? {} : { step: outcome.step }),
    code,
    ...(refused ? { refused: true } : {}),
    ...(refused && violations.length > 0
      ? { contentViolations: Object.freeze([...violations]) }
      : {}),
  });
}

/**
 * How bad the end of a run is for the exit code: a failure in a file of
 * the runner, one a later try may pass, a refusal of the policy, of a kill
 * switch, of a right or of the sign-in, a configuration that does not fit,
 * an internal fault, or else data or an answer that did not fit.
 *
 * @param outcome - How the run ended.
 * @returns Its severity.
 * @example
 * ```ts
 * severityOf({ result: 'failed', step: 'input', code: 'network', final: false }); // 'temporary'
 * ```
 */
export function severityOf(outcome: RunOutcome): RunnerSeverity {
  if (outcome.result !== 'failed') return 'ok';
  if (outcome.file === true) return 'file';
  if (!outcome.final) return 'temporary';
  switch (auditEndOf(outcome).code) {
    case 'internal':
      return 'internal';
    case 'config':
      return 'config';
    case 'auth':
    case 'permission':
    case 'policy_denied':
    case 'license_required':
    case 'confirmation_required':
      return 'refused';
    default:
      return 'data';
  }
}
