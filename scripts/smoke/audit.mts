/**
 * The check of the audit file of one server process.
 *
 * With a folder of state the server writes every audit line first into its
 * own file, one per process and UTC day, and the result of a tool with
 * personal data of special categories goes out only once its line is in
 * that file (ADR 0028). The smoke test gives each process a folder of its
 * own and checks afterwards: one valid line per call of a tool, in order,
 * with tool and outcome, at most 100 IDs of objects only in their fixed
 * form, and nothing of the search term, the answers or the token.
 * Afterwards `ecclium audit verify` of the same build checks the chain of
 * the files against the anchors in the stderr of the process.
 *
 * @packageDocumentation
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Call } from './answers.mts';
import { holdsAny, type JsonLine } from './course.mts';

/** The words the result of this check uses, for the allow list. */
export const auditWords = [
  'audit',
  'kette',
  'wie erwartet',
  'abweichend',
] as const;

const fileName = /^audit-\d{4}-\d{2}-\d{2}-\d{6}-\d+-\d+\.jsonl$/;

// An ID of an object as the audit file writes it: one of the closed list
// of kinds and digits or a GUID, never a name (ADR 0028).
const objectRef =
  /^(?:person|group|event|appointment|calendar|resource|booking|service|song|wiki_category|wiki_page):(?:[0-9]{1,16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const isObjectRefs = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((ref) => typeof ref === 'string' && objectRef.test(ref));

/**
 * Reads the lines of every audit file in a folder of state, files in the
 * order of their names. A line counts only if it ends with a line break and
 * not with `~`, which marks the rest of a line the file did not take whole.
 *
 * @param stateDir - The folder of state the server got.
 * @returns The parsed lines, or `undefined` if a line is no JSON object or a file has an unknown name.
 */
export function readAuditLines(stateDir: string): JsonLine[] | undefined {
  const folder = join(stateDir, 'audit');
  let names: string[];
  try {
    names = readdirSync(folder).sort();
  } catch {
    return [];
  }
  const lines: JsonLine[] = [];
  for (const name of names) {
    if (!fileName.test(name)) return undefined;
    const text = readFileSync(join(folder, name), 'utf8');
    const parts = text.split('\n');
    // The part after the last line break never ended: a rest, not a line.
    parts.pop();
    for (const part of parts) {
      if (part.endsWith('~')) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(part);
      } catch {
        return undefined;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
      }
      lines.push(value as JsonLine);
    }
  }
  return lines;
}

/**
 * Checks the audit lines of one process against its calls.
 *
 * @param lines - The lines from {@link readAuditLines}.
 * @param calls - The calls of the process, in order.
 * @param banned - Texts no line may hold: token, search term, names.
 * @returns Whether the file holds exactly what it should.
 */
export function auditFits(
  lines: readonly JsonLine[] | undefined,
  calls: readonly Call[],
  banned: readonly string[],
): boolean {
  if (lines?.length !== calls.length) return false;
  return (
    lines.every((line, index) => {
      const call = calls[index];
      if (call === undefined) return false;
      const outcomeFits =
        call.expect === 'ok'
          ? line['outcome'] === 'ok' && !('errorCode' in line)
          : line['outcome'] === 'error' && line['errorCode'] === call.expect;
      const actor = line['actor'];
      return (
        line['v'] === 1 &&
        typeof line['eventId'] === 'string' &&
        typeof line['ts'] === 'string' &&
        line['type'] === 'tool_call' &&
        line['tenantId'] === 'default' &&
        typeof actor === 'object' &&
        actor !== null &&
        line['mode'] === 'interactive' &&
        typeof line['durationMs'] === 'number' &&
        line['tool'] === call.tool &&
        outcomeFits &&
        isObjectRefs(line['objectRefs'])
      );
    }) && !holdsAny(lines, banned)
  );
}

/** How the smoke test starts `ecclium` for a command other than stdio. */
export interface AuditCommand {
  /** Usually Node.js itself. */
  readonly executable: string;
  /** Arguments before the entry, empty in a real run. */
  readonly preArgs: readonly string[];
  /** The entry of the command `ecclium`. */
  readonly entry: string;
  /** More variables for the child, only in tests. */
  readonly env?: Readonly<Record<string, string>>;
}

// The line of `ecclium audit verify` when every file named by an anchor
// ends with the line of its anchor, and there is at least one.
const anchoredLine =
  /^ {2}Dateien mit einem Anker aus dem Log: ([1-9]\d*), davon passend \1,/m;

/**
 * Checks the audit files of one process with `ecclium audit verify` of the
 * same build, with the stderr of the process as the log of its anchors
 * (ADR 0028). It passes when the command ends with 0 and every anchor fits
 * its file. The child gets only the folder of state, neither the address
 * nor the token, which the command does not need.
 *
 * @param command - How to start `ecclium`.
 * @param stateDir - The folder of state of the process.
 * @param stderr - Everything the process wrote to stderr.
 * @returns Whether the chains are whole and fit their anchors.
 */
export function chainFits(
  command: AuditCommand,
  stateDir: string,
  stderr: string,
): boolean {
  const result = spawnSync(
    command.executable,
    [...command.preArgs, command.entry, 'audit', 'verify', '--log', '-'],
    {
      env: { ...command.env, ECCLIUM_STATE_DIR: stateDir },
      input: stderr,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1_048_576,
    },
  );
  return result.status === 0 && anchoredLine.test(result.stdout);
}
