/**
 * The categories of the wiki, the calendars and the resources that write
 * tools reached, as the audit files show them, for `ecclium policy init
 * --interactive` (ADR 0032). It reads only through the opened folder
 * `audit` and takes from each line no more than the day, the tool, the
 * state of the write and the IDs of the categories, calendars and
 * resources, never an ID of a person.
 *
 * A line counts when it is a call of a write tool in the interactive mode
 * whose `objectRefs` name a category, a calendar or a resource; a write to
 * a page that the guard planned names its category as well, one of an
 * appointment its calendar and one of a booking its resource, as the
 * policy counts them there (ADR 0032). An undo of `ecclium undo` never
 * counts, since it is no write of the model but the operator taking one
 * back (ADR 0031); like every valid line, it still widens the days read.
 * Every counted line makes its category, calendar or resource a target,
 * also a refused one, since a target without an entry is what the
 * operator wants to see. For the daily limit the refused and the skipped
 * calls do not count, and neither does a call that ended with a question
 * to the person: its answer is a call of its own, whose line carries the
 * state of the write (ADR 0029). Every other one counts, also one that
 * failed, since the audit does not tell whether it failed before or after
 * it planned.
 *
 * @packageDocumentation
 */
import type { WriteState } from '@ecclium/mcp-churchtools-plugin-api';

import type { AuditFolder } from './reader.js';
import { auditEventV1Schema } from './schema.js';

/** A category, calendar or resource that write tools reached. */
export interface WriteTargetObject {
  /** The ID of the category, calendar or resource. */
  readonly id: number;
  /** The write tools seen on it, sorted. */
  readonly tools: readonly string[];
  /**
   * The most calls of one of these tools on it on one UTC day, without the
   * refused and the skipped ones; 0 when the audit shows only those.
   */
  readonly highestPerDay: number;
}

/** A category of the wiki that write tools reached. */
export type WriteTargetCategory = WriteTargetObject;

/** What the audit files show of the targets of writes. */
export interface WriteTargets {
  /** The categories, sorted by ID. */
  readonly categories: readonly WriteTargetObject[];
  /** The calendars, sorted by ID. */
  readonly calendars: readonly WriteTargetObject[];
  /** The resources, sorted by ID. */
  readonly resources: readonly WriteTargetObject[];
  /** The first and the last UTC day of a valid line, if there was one. */
  readonly days?: { readonly first: string; readonly last: string };
  /** The files read whole. */
  readonly read: number;
  /** The files that could not be read whole. */
  readonly unread: number;
  /** Whether the folder `audit` was no longer the one opened. */
  readonly moved: boolean;
}

// The states of a call that count for the limit. A refused and a skipped
// call wrote nothing and say nothing about how often a tool writes; a
// planned one asked the person, whose answer is counted on its own line.
const countingStates: readonly WriteState[] = Object.freeze([
  'queued',
  'verified',
  'conflict',
  'failed',
  'rolledBack',
]);

// The largest ID of an object of ChurchTools, as the policy takes it.
const maxId = 2_147_483_647;
// The kinds of an object the policy has an entry for by ID alone, as the
// audit names them; an appointment names its calendar, a booking its
// resource, a page its category.
const targetRef = /^(wiki_category|calendar|resource):([1-9]\d{0,9})$/;
type TargetKind = 'wiki_category' | 'calendar' | 'resource';

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The counts of one target while they grow. */
interface Growing {
  readonly tools: Set<string>;
  // Calls that count, per tool and day: `<day> <tool>`.
  readonly perDay: Map<string, number>;
}

// The targets of one kind, sorted by ID and frozen.
const listOf = (
  targets: ReadonlyMap<number, Growing>,
): readonly WriteTargetObject[] =>
  Object.freeze(
    [...targets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, target]) =>
        Object.freeze({
          id,
          tools: Object.freeze([...target.tools].sort()),
          highestPerDay: Math.max(0, ...target.perDay.values()),
        }),
      ),
  );

/**
 * Collects the categories of the wiki, the calendars and the resources
 * that write tools reached.
 *
 * @param folder - The opened folder `audit`.
 * @returns The targets with their tools and highest day, the days and how
 *   the reading went, frozen.
 * @example
 * ```ts
 * const opened = openAuditFolder({ stateDir });
 * if (opened.ok) collectWriteTargets(opened.folder).calendars;
 * ```
 */
export function collectWriteTargets(folder: AuditFolder): WriteTargets {
  const found: Readonly<Record<TargetKind, Map<number, Growing>>> = {
    wiki_category: new Map(),
    calendar: new Map(),
    resource: new Map(),
  };
  let first: string | undefined;
  let last: string | undefined;
  let read = 0;
  let unread = 0;
  let moved = false;
  for (const name of folder.names) {
    const outcome = folder.read(name, (line) => {
      if (line.piece) return;
      const parsed = auditEventV1Schema.safeParse(parse(line.text));
      if (!parsed.success) return;
      const event = parsed.data;
      const day = event.ts.slice(0, 10);
      if (first === undefined || day < first) first = day;
      if (last === undefined || day > last) last = day;
      const { tool, writeState } = event;
      if (
        event.type !== 'tool_call' ||
        event.mode !== 'interactive' ||
        tool === undefined ||
        writeState === undefined
      ) {
        return;
      }
      const counts = countingStates.includes(writeState);
      for (const ref of event.objectRefs) {
        const match = targetRef.exec(ref);
        const id = Number(match?.[2]);
        if (match === null || id > maxId) continue;
        const targets = found[match[1] as TargetKind];
        let target = targets.get(id);
        if (target === undefined) {
          target = { tools: new Set(), perDay: new Map() };
          targets.set(id, target);
        }
        // A confirmation by echo plans nothing; its write belongs to the
        // tool that planned it, which a policy names (ADR 0029).
        if (tool === 'ct_write_confirm') continue;
        target.tools.add(tool);
        if (counts) {
          const key = `${day} ${tool}`;
          target.perDay.set(key, (target.perDay.get(key) ?? 0) + 1);
        }
      }
    });
    if (outcome === 'read') read += 1;
    else if (outcome === 'moved') moved = true;
    else if (outcome !== 'gone') unread += 1;
  }
  return Object.freeze({
    categories: listOf(found.wiki_category),
    calendars: listOf(found.calendar),
    resources: listOf(found.resource),
    ...(first === undefined || last === undefined
      ? {}
      : { days: Object.freeze({ first, last }) }),
    read,
    unread,
    moved,
  });
}
