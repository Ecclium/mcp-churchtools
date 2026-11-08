/**
 * The check of the audit files of a run of the smoke test for writing.
 *
 * Every process that writes into the folder of state has its own file,
 * the three servers and each command of the operator (ADR 0028). The
 * check reads them all and compares:
 *
 * - the lines of tool calls, in the order of the files, with the lines the
 *   course expects: tool, outcome, error code, state of the write and way
 *   of the confirmation, each only where expected, so that every write
 *   attempt has exactly one line and says how it was confirmed (ADR 0029);
 * - one line of the type `undo` for each run of undo that looked for its
 *   snapshot, naming the write it takes back, with the outcome its exit
 *   code says: 0 a write back or a delete confirmed by the operator, 65 a
 *   target someone changed, refused with the code of a conflict because
 *   nothing was sent (ADR 0029, ADR 0031);
 * - one line of the type `approval` for each approval, with the decision
 *   and the state of its write;
 * - and that no line holds the token or a text the run wrote.
 *
 * @packageDocumentation
 */
import { readAuditLines } from '../smoke/audit.mts';
import { holdsAny, type JsonLine } from '../smoke/course.mts';
import type { Expected, UndoRun } from './course.mts';

// An ID of an object as the audit file writes it, never a name (ADR 0028).
const objectRef =
  /^(?:person|group|event|appointment|calendar|resource|booking|service|song|wiki_category|wiki_page):(?:[0-9]{1,16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

const isObjectRefs = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((ref) => typeof ref === 'string' && objectRef.test(ref));

// A field fits when it is there with the expected value, or missing where
// nothing is expected.
const fieldFits = (line: JsonLine, key: string, expected?: string): boolean =>
  expected === undefined ? !(key in line) : line[key] === expected;

const lineFits = (line: JsonLine, expected: Expected): boolean =>
  line['v'] === 1 &&
  typeof line['eventId'] === 'string' &&
  line['tenantId'] === 'default' &&
  line['mode'] === 'interactive' &&
  line['tool'] === expected.tool &&
  line['outcome'] === expected.outcome &&
  fieldFits(line, 'errorCode', expected.errorCode) &&
  fieldFits(line, 'writeState', expected.writeState) &&
  fieldFits(line, 'confirmation', expected.confirmation) &&
  isObjectRefs(line['objectRefs']);

// The words a line of a tool call may carry in the fields the check
// compares, all fixed by the schema of the audit (ADR 0028). Anything else
// shows as unknown, so that no value of the line can reach the output.
const outcomes = ['ok', 'error', 'denied'];
const writeStates = [
  'planned',
  'queued',
  'verified',
  'skipped',
  'denied',
  'conflict',
  'failed',
  'rolledBack',
];
const errorCodes = [
  'config',
  'auth',
  'permission',
  'not_found',
  'validation',
  'conflict',
  'rate_limited',
  'upstream',
  'network',
  'policy_denied',
  'confirmation_required',
  'license_required',
  'internal',
];
const confirmations = ['elicitation', 'echo', 'policy', 'operator'];

/** The fixed words the differences use, for the allow list of the guard. */
export const differenceWords = [
  'zeile',
  'erwartet',
  'ist',
  'tool',
  'ausgang',
  'zustand',
  'code',
  'weg',
  'keiner',
  'keine zeile',
  'unbekannt',
  ...outcomes,
  ...writeStates,
  ...errorCodes,
  ...confirmations,
] as const;

// One field as a fixed word: the word itself if the list knows it, «keiner»
// without a value, «unbekannt» otherwise.
const wordOf = (value: unknown, known: readonly string[]): string =>
  value === undefined
    ? 'keiner'
    : typeof value === 'string' && known.includes(value)
      ? value
      : 'unbekannt';

/** One line of a tool call as fixed words, for the output. */
export interface LineWords {
  readonly tool: string;
  readonly ausgang: string;
  readonly zustand: string;
  readonly code: string;
  readonly weg: string;
}

const wordsOfLine = (
  line: JsonLine | Expected,
  tools: readonly string[],
): LineWords => {
  const field = (key: string): unknown =>
    (line as Readonly<Record<string, unknown>>)[key];
  return {
    tool: wordOf(field('tool'), tools),
    ausgang: wordOf(field('outcome'), outcomes),
    zustand: wordOf(field('writeState'), writeStates),
    code: wordOf(field('errorCode'), errorCodes),
    weg: wordOf(field('confirmation'), confirmations),
  };
};

/** Where the lines of tool calls differ from the expected ones. */
export interface AuditDifference {
  /** The number of the call in the run, from 1. */
  readonly zeile: number;
  readonly erwartet: LineWords | 'keine zeile';
  readonly ist: LineWords | 'keine zeile';
}

/** The most differences the output names. */
export const maxDifferences = 40;

/** What the check found, by part. */
export interface AuditCheck {
  /** Whether the lines of tool calls are exactly the expected ones. */
  readonly calls: boolean;
  /** Whether each run of undo and each approval has its one line. */
  readonly operator: boolean;
  /** Whether no line holds the token or a text of the run. */
  readonly clean: boolean;
  /** The first lines of tool calls that differ, as fixed words. */
  readonly differences: readonly AuditDifference[];
}

/**
 * Checks the audit files of a run.
 *
 * @param stateDir - The folder of state of the run.
 * @param expected - The expected lines of tool calls, all processes in order.
 * @param undoes - Each run of undo: the write it took back or tried to, and its exit code.
 * @param approvals - The IDs of the approved entries of the queue.
 * @param banned - The token and the texts of the run.
 * @param tools - The names of the tools the run calls, for the differences.
 * @returns What fits.
 */
export function checkAudit(
  stateDir: string,
  expected: readonly Expected[],
  undoes: readonly UndoRun[],
  approvals: readonly string[],
  banned: readonly string[],
  tools: readonly string[],
): AuditCheck {
  const lines = readAuditLines(stateDir);
  if (lines === undefined) {
    return { calls: false, operator: false, clean: false, differences: [] };
  }
  const calls = lines.filter((line) => line['type'] === 'tool_call');
  const undoLines = lines.filter((line) => line['type'] === 'undo');
  const approvalLines = lines.filter((line) => line['type'] === 'approval');
  const callsFit =
    calls.length === expected.length &&
    calls.every((line, index) => {
      const entry = expected[index];
      return entry !== undefined && lineFits(line, entry);
    });
  const sorted = (values: readonly unknown[]): string =>
    JSON.stringify([...values].map(String).sort());
  // The runs of undo started one after the other, but two in one second
  // can sort either way by their files, so they are compared as a set.
  const undoKey = (...fields: readonly unknown[]): string =>
    JSON.stringify(fields);
  // The line a run of undo must leave by its exit code. Another code is a
  // failed step of its own; its line need only name the write.
  const expectedUndo = (run: UndoRun): string | undefined =>
    run.status === 0
      ? undoKey(run.id, 'ok', 'verified', undefined, 'operator')
      : run.status === 65
        ? undoKey(run.id, 'denied', 'denied', 'conflict', undefined)
        : undefined;
  const left = undoLines.map((line) => ({
    id: line['undoes'],
    key: undoKey(
      line['undoes'],
      line['outcome'],
      line['writeState'],
      line['errorCode'],
      line['confirmation'],
    ),
  }));
  const undoesFit =
    undoLines.length === undoes.length &&
    undoes.every((run) => {
      const key = expectedUndo(run);
      const index = left.findIndex((line) =>
        key === undefined ? line.id === run.id : line.key === key,
      );
      if (index < 0) return false;
      left.splice(index, 1);
      return true;
    });
  const operatorFits =
    lines.length === calls.length + undoLines.length + approvalLines.length &&
    undoesFit &&
    undoLines.every(
      (line) => line['mode'] === 'operator' && !('tool' in line),
    ) &&
    sorted(approvalLines.map((line) => line['queueId'])) ===
      sorted(approvals) &&
    approvalLines.every(
      (line) =>
        line['mode'] === 'operator' &&
        line['decision'] === 'approved' &&
        line['writeState'] === 'verified' &&
        line['confirmation'] === 'operator',
    );
  const differences: AuditDifference[] = [];
  for (
    let index = 0;
    index < Math.max(calls.length, expected.length) &&
    differences.length < maxDifferences;
    index += 1
  ) {
    const line = calls[index];
    const entry = expected[index];
    if (line !== undefined && entry !== undefined && lineFits(line, entry)) {
      continue;
    }
    differences.push({
      zeile: index + 1,
      erwartet: entry === undefined ? 'keine zeile' : wordsOfLine(entry, tools),
      ist: line === undefined ? 'keine zeile' : wordsOfLine(line, tools),
    });
  }
  return {
    calls: callsFit,
    operator: operatorFits,
    clean: !holdsAny(lines, banned),
    differences,
  };
}
