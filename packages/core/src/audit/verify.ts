/**
 * Checks the audit files against their chains and, if given, against the
 * anchors from a log, for `ecclium audit verify` (ADR 0028).
 *
 * The chain of a file: its first whole line carries `seq` 1 and as
 * `prevHash` the SHA-256 of the name of the file, each further whole line
 * the next `seq` and the SHA-256 of the whole line before it, over its
 * bytes as they stand in the file. Pieces, which end in `~`, are no part
 * of it. After a break the check goes on from the line that is in the
 * file, so that each break shows on its own and at its place: a changed
 * line breaks the link to the next one, a removed, added or swapped line
 * the number and the link, a renamed file the first link.
 *
 * An anchor names a file, the `seq` of its last whole line and the hash of
 * that line, as the server logs it when it gives the file up. A file must
 * end with that line. A file without an anchor is never a finding: a
 * crash, a client that drops stderr or a log nobody kept leave none.
 *
 * What this module returns names files, never a path, and never the
 * content of a line.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { isAuditFileName, isSha256 } from '../logger/index.js';
import type { AuditFolder, AuditLine } from './reader.js';
import { dayOfAuditFile, dayOfTime, isPastRetention } from './retention.js';

/** The anchor of the chain of one file, from a line of the log. */
export interface AuditAnchor {
  /** The name of the file, without a folder. */
  readonly file: string;
  /** The `seq` of its last whole line. */
  readonly seq: number;
  /** The SHA-256 of its last whole line, in lower-case hex. */
  readonly hash: string;
}

/** The anchors read from logs. */
export interface AuditAnchorSet {
  /** One anchor per file, for files with exactly one anchor. */
  readonly anchors: ReadonlyMap<string, AuditAnchor>;
  /** The names of files with two different anchors, sorted. */
  readonly conflicts: readonly string[];
  /** Anchors left out beyond {@link maxAnchors} files. */
  readonly dropped: number;
}

/** Gathers the anchors from the lines of logs. */
export interface AuditAnchorCollector {
  /**
   * Takes one line of a log. A line that holds no anchor is skipped
   * without a trace.
   *
   * @param line - One line of a log, without its line break.
   * @returns Whether the line held an anchor.
   */
  add(line: string): boolean;
  /**
   * Returns what was gathered.
   *
   * @returns The anchors, frozen.
   */
  result(): AuditAnchorSet;
}

/**
 * The kinds of finding, frozen:
 *
 * - `line_form`: a whole line that is no JSON object, holds bytes outside
 *   printable ASCII or has a `seq` or `prevHash` of another form.
 * - `line_too_long`: a whole line longer than a line of the log may be.
 * - `chain_mixed`: a line with a chain in a file without one, or the other
 *   way round.
 * - `chain_name`: the first link is not the hash of the name of the file.
 * - `chain_link`: a `prevHash` is not the hash of the line before.
 * - `chain_seq`: a `seq` does not follow the one before.
 * - `anchor_mismatch`: the line the anchor names differs from the anchor.
 * - `anchor_truncated`: the file ends before the line the anchor names.
 * - `anchor_extended`: whole lines follow the line the anchor names.
 * - `anchor_conflict`: the logs hold two different anchors for the file.
 * - `file_missing`: an anchor names a file that is not there and whose
 *   retention has not passed.
 * - `file_unsafe`: an entry with the name of an audit file that fails a
 *   check: a link, a folder, a file of another owner, with rights for
 *   others or more than one link.
 * - `file_unreadable`: a file that could not be read whole.
 * - `folder_moved`: the folder `audit` changed during the check, which
 *   then stops.
 */
export const auditFindingKinds = Object.freeze([
  'line_form',
  'line_too_long',
  'chain_mixed',
  'chain_name',
  'chain_link',
  'chain_seq',
  'anchor_mismatch',
  'anchor_truncated',
  'anchor_extended',
  'anchor_conflict',
  'file_missing',
  'file_unsafe',
  'file_unreadable',
  'folder_moved',
] as const);

/** The kind of a finding. */
export type AuditFindingKind = (typeof auditFindingKinds)[number];

/** One finding: its kind, the file and, for a line, its number. */
export interface AuditFinding {
  readonly kind: AuditFindingKind;
  /** The name of the file, without a folder. */
  readonly file: string;
  /** The number of the line in the file, from 1, for findings of a line. */
  readonly line?: number;
}

/** What {@link verifyAuditFiles} found, as numbers and findings. */
export interface AuditVerifyReport {
  /** The audit files in the folder. */
  readonly files: number;
  /** The files read whole. */
  readonly checked: number;
  /** Of them, the files whose lines carry no chain. */
  readonly unchained: number;
  /** The whole lines of the files read whole. */
  readonly lines: number;
  /** The other entries in the folder, which the check leaves alone. */
  readonly others: number;
  /** The files that went before they were read, such as by a sweep. */
  readonly vanished: number;
  /** The files with exactly one anchor. */
  readonly anchors: number;
  /** The anchors whose file ends with the line they name. */
  readonly anchorsMatched: number;
  /** The anchors whose file is gone after its retention, no finding. */
  readonly anchorsExpired: number;
  /** The first {@link maxFindings} findings. */
  readonly findings: readonly AuditFinding[];
  /** The findings beyond them. */
  readonly findingsOmitted: number;
}

/** Options of {@link verifyAuditFiles}. */
export interface AuditVerifyOptions {
  /** The opened folder `audit`. */
  readonly folder: AuditFolder;
  /** The anchors from logs, if any were given. */
  readonly anchors?: AuditAnchorSet | undefined;
  /**
   * The retention in months, a whole number from 1 to 120: an anchor
   * whose file is gone after it is no finding.
   */
  readonly retentionMonths: number;
  /** The clock that gives the current UTC day. */
  readonly clock: Clock;
}

/** The most findings a report lists. */
export const maxFindings = 100;

/**
 * The most files the anchors of a collector cover, far above one file per
 * process and day over the longest retention.
 */
export const maxAnchors = 100_000;

/**
 * The longest line of a log that may hold an anchor. Longer lines are
 * skipped, so that no line makes the parse costly.
 */
export const maxLogLineLength = 1_048_576;

const anchorEvent = 'audit_chain_anchor';

// Where the JSON of a line of the log starts, as the logger writes it,
// also after a prefix such as a time or the name of a server that a client
// puts before each line of stderr.
const logLineStart = '{"ts":"';

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// A plain object as JSON.parse makes it, never an array.
const parseObject = (
  text: string | undefined,
): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

const isSeq = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/**
 * Reads the anchor from one line of a log: the JSON object from
 * `{"ts":"` to the last brace, with the event `audit_chain_anchor` and a
 * `file`, `seq` and `hash` of the form the logger writes. A line longer
 * than {@link maxLogLineLength} holds none.
 *
 * @param line - One line of a log, without its line break.
 * @returns The anchor, or undefined.
 * @example
 * ```ts
 * anchorOfLogLine(
 *   '{"ts":"2026-10-31T12:00:00.000Z","level":"info","event":"audit_chain_anchor","file":"audit-2026-10-31-120000-4242-1.jsonl","seq":3,"hash":"…"}',
 * ); // { file: 'audit-2026-10-31-120000-4242-1.jsonl', seq: 3, hash: '…' }
 * ```
 */
export function anchorOfLogLine(line: string): AuditAnchor | undefined {
  if (typeof line !== 'string' || line.length > maxLogLineLength) {
    return undefined;
  }
  const start = line.indexOf(logLineStart);
  if (start < 0) return undefined;
  const value = parseObject(line.slice(start, line.lastIndexOf('}') + 1));
  if (value === undefined) return undefined;
  const file = own(value, 'file');
  const seq = own(value, 'seq');
  const hash = own(value, 'hash');
  if (
    own(value, 'event') !== anchorEvent ||
    !isAuditFileName(file) ||
    !isSeq(seq) ||
    !isSha256(hash)
  ) {
    return undefined;
  }
  return Object.freeze({ file, seq, hash });
}

/**
 * Makes a collector for the anchors of one or more logs. The same anchor
 * twice, as in two copies of a log, counts once. Two different anchors for
 * one file are a conflict, and that file gets none. Beyond
 * {@link maxAnchors} files it counts the anchors it leaves out.
 *
 * @returns The collector.
 * @example
 * ```ts
 * const collector = createAnchorCollector();
 * for (const line of lines) collector.add(line);
 * const anchors = collector.result();
 * ```
 */
export function createAnchorCollector(): AuditAnchorCollector {
  const anchors = new Map<string, AuditAnchor>();
  const conflicts = new Set<string>();
  let dropped = 0;
  return Object.freeze({
    add(line: string): boolean {
      const anchor = anchorOfLogLine(line);
      if (anchor === undefined) return false;
      const known = anchors.get(anchor.file);
      if (known === undefined) {
        if (anchors.size < maxAnchors) anchors.set(anchor.file, anchor);
        else dropped += 1;
      } else if (known.seq !== anchor.seq || known.hash !== anchor.hash) {
        conflicts.add(anchor.file);
      }
      return true;
    },
    result(): AuditAnchorSet {
      const shown = new Map(
        [...anchors].filter(([file]) => !conflicts.has(file)),
      );
      return Object.freeze({
        anchors: shown,
        conflicts: Object.freeze([...conflicts].sort()),
        dropped,
      });
    },
  });
}

/** The chain of one file as the check reads it. */
interface FileState {
  /** Whether its lines carry a chain, once a valid line shows it. */
  mode: 'unknown' | 'chained' | 'unchained';
  /** The seq the next whole line must carry. */
  expected: number;
  /** The hash the next whole line must carry as prevHash. */
  previous: string;
  /** The whole lines so far. */
  whole: number;
  /** The highest valid seq so far. */
  maxSeq: number | undefined;
  /** The hash of the first whole line with the seq of the anchor. */
  atAnchor: string | undefined;
  /** The hash of the last whole line. */
  lastHash: string | undefined;
}

// The finding of one whole line, if any, and the next state of the chain.
const checkLine = (
  state: FileState,
  line: AuditLine,
  anchor: AuditAnchor | undefined,
): AuditFindingKind | undefined => {
  if (line.tooLong) {
    state.expected += 1;
    return 'line_too_long';
  }
  const value = parseObject(line.text);
  if (value === undefined) {
    state.expected += 1;
    return 'line_form';
  }
  const seq = own(value, 'seq');
  const prevHash = own(value, 'prevHash');
  const chained = seq !== undefined || prevHash !== undefined;
  if (state.mode === 'unknown') state.mode = chained ? 'chained' : 'unchained';
  if (chained !== (state.mode === 'chained')) {
    state.expected += 1;
    return 'chain_mixed';
  }
  if (!chained) {
    state.expected += 1;
    return undefined;
  }
  if (!isSeq(seq) || !isSha256(prevHash)) {
    state.expected += 1;
    return 'line_form';
  }
  if (anchor?.seq === seq && state.atAnchor === undefined) {
    state.atAnchor = line.hash;
  }
  state.maxSeq = Math.max(state.maxSeq ?? 0, seq);
  const expected = state.expected;
  state.expected = seq + 1;
  if (prevHash !== state.previous) {
    return state.whole === 1 ? 'chain_name' : 'chain_link';
  }
  return seq === expected ? undefined : 'chain_seq';
};

// The finding of a file read whole against its anchor, if any.
const compareAnchor = (
  state: FileState,
  anchor: AuditAnchor,
): AuditFindingKind | undefined => {
  if (state.atAnchor === undefined) {
    return state.whole === 0 ||
      (state.maxSeq !== undefined && state.maxSeq < anchor.seq)
      ? 'anchor_truncated'
      : 'anchor_mismatch';
  }
  if (state.atAnchor !== anchor.hash) return 'anchor_mismatch';
  return state.lastHash === anchor.hash ? undefined : 'anchor_extended';
};

/**
 * Checks every audit file of the folder against its chain and, if given,
 * against its anchor, and every anchor without a file against the
 * retention. It reads only, through the folder, and never throws for what
 * it finds on disk.
 *
 * @param options - The folder, the anchors, the retention and the clock.
 * @returns The report, frozen.
 * @throws {TypeError} When the retention is no whole number from 1 to 120
 *   or the clock has no `now`.
 * @example
 * ```ts
 * const report = verifyAuditFiles({ folder, anchors, retentionMonths: 12, clock: systemClock });
 * if (report.findings.length > 0) process.exitCode = 65;
 * ```
 */
export function verifyAuditFiles(
  options: AuditVerifyOptions,
): AuditVerifyReport {
  const { folder, anchors, retentionMonths, clock } = options;
  if (
    !Number.isInteger(retentionMonths) ||
    retentionMonths < 1 ||
    retentionMonths > 120 ||
    typeof (clock as Partial<Clock> | null)?.now !== 'function'
  ) {
    throw new TypeError('The check needs a retention and a clock.');
  }
  const anchorOf = anchors?.anchors ?? new Map<string, AuditAnchor>();
  const findings: AuditFinding[] = [];
  let findingsOmitted = 0;
  const add = (kind: AuditFindingKind, file: string, line?: number): void => {
    if (findings.length < maxFindings) {
      findings.push(
        Object.freeze(
          line === undefined ? { kind, file } : { kind, file, line },
        ),
      );
    } else {
      findingsOmitted += 1;
    }
  };

  let today: string | undefined;
  try {
    today = dayOfTime(clock.now());
  } catch {
    today = undefined;
  }
  let checked = 0;
  let unchained = 0;
  let lines = 0;
  let vanished = 0;
  let anchorsMatched = 0;
  let anchorsExpired = 0;
  // The files whose anchor is judged here, by a file read or gone.
  const judged = new Set<string>();
  let moved = false;

  // An anchor whose file is not there: no finding after its retention.
  const missing = (file: string): void => {
    const day = dayOfAuditFile(file);
    if (
      today !== undefined &&
      day !== undefined &&
      isPastRetention(day, retentionMonths, today)
    ) {
      anchorsExpired += 1;
    } else {
      add('file_missing', file);
    }
  };

  for (const name of folder.names) {
    const anchor = anchorOf.get(name);
    const state: FileState = {
      mode: 'unknown',
      expected: 1,
      previous: sha256(name),
      whole: 0,
      maxSeq: undefined,
      atAnchor: undefined,
      lastHash: undefined,
    };
    let fileLines = 0;
    const outcome = folder.read(name, (line) => {
      if (line.piece) return;
      state.whole += 1;
      fileLines += 1;
      const kind = checkLine(state, line, anchor);
      if (kind !== undefined) add(kind, name, line.number);
      state.previous = line.hash;
      state.lastHash = line.hash;
    });
    if (outcome === 'moved') {
      add('folder_moved', name);
      moved = true;
      break;
    }
    judged.add(name);
    if (outcome === 'gone') {
      vanished += 1;
      if (anchor !== undefined) missing(name);
      continue;
    }
    if (outcome === 'unsafe') {
      add('file_unsafe', name);
      continue;
    }
    if (outcome === 'unreadable') {
      add('file_unreadable', name);
      continue;
    }
    checked += 1;
    lines += fileLines;
    if (state.mode === 'unchained') unchained += 1;
    if (anchor !== undefined) {
      const kind = compareAnchor(state, anchor);
      if (kind === undefined) anchorsMatched += 1;
      else add(kind, name);
    }
  }

  for (const file of anchors?.conflicts ?? []) add('anchor_conflict', file);
  // After a move the folder can no longer tell which files are there.
  if (!moved) {
    const names = new Set(folder.names);
    for (const file of [...anchorOf.keys()].sort()) {
      if (!judged.has(file) && !names.has(file)) missing(file);
    }
  }

  return Object.freeze({
    files: folder.names.length,
    checked,
    unchained,
    lines,
    others: folder.others,
    vanished,
    anchors: anchorOf.size,
    anchorsMatched,
    anchorsExpired,
    findings: Object.freeze(findings),
    findingsOmitted,
  });
}
