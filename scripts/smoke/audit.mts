/**
 * The check of the audit file of one server process.
 *
 * With a folder of state the server writes every audit line first into its
 * own file, one per process and UTC day, and the result of a tool with
 * personal data of special categories goes out only once its line is in
 * that file (ADR 0028). The smoke test gives each process a folder of its
 * own and checks afterwards: one valid line per call of a tool, in order,
 * with tool and outcome, no object references, and nothing of the search
 * term, the answers or the token.
 *
 * @packageDocumentation
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { holdsAny, type Call, type JsonLine } from './course.mts';

/** The words the result of this check uses, for the allow list. */
export const auditWords = ['audit', 'wie erwartet', 'abweichend'] as const;

const fileName = /^audit-\d{4}-\d{2}-\d{2}-\d{6}-\d+-\d+\.jsonl$/;

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
      const refs = line['objectRefs'];
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
        Array.isArray(refs) &&
        refs.length === 0
      );
    }) && !holdsAny(lines, banned)
  );
}
