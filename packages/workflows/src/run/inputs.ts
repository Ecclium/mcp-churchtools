/**
 * Reading the inputs of a run (ADR 0033).
 *
 * Where it stands in a run: after the preparation, before the model. Each
 * input reads through a port the composition root built over the pipeline,
 * with the actor of the routine and the mode `unattended`, in the level of
 * the model. The engine never sets actor, mode or level itself, never sees
 * an ID behind a pseudonym, and gets every result with the mark of the
 * pipeline, which only the pipeline makes.
 *
 * What it does with a routine:
 *
 * - A parameter such as `+14d` becomes the day of the trigger in the zone
 *   of the configuration plus 14 days, never the day of the run, so that a
 *   late run reads the same days as one on time (ADR 0034).
 * - An input with `forEach` calls its tool once per entry of its source,
 *   with `{ field }` taken from the entry as the model will see it; in
 *   `strict` a pseudonym, which the pipeline turns back into its ID.
 * - A tool with pages reads the next page while its result says `more`
 *   and the input may pass on more entries.
 * - Every input passes on at most `maxItems` entries over all its calls,
 *   and a run makes at most a fixed number of calls. A routine that would
 *   need more ends, so that no list is cut without a word: an entry of a
 *   source left without its call ends the run, and a list cut inside one
 *   call says so with `more`.
 *
 * @packageDocumentation
 */
import type { RunCallOutcome, Trigger } from '@ecclium/mcp-churchtools-core';
import type { ErrorCode, Logger } from '@ecclium/mcp-churchtools-plugin-api';

import { isParamField, isParamList } from '../routine/schema.js';
import type { PreparedInput, PreparedRun } from './prepare.js';

/** The limits of the reads of a run, frozen. */
export const runReadLimits = Object.freeze({
  /** The most calls of one input, pages included. */
  callsPerInput: 200,
  /** The most calls of a run. */
  callsPerRun: 400,
} as const);

/**
 * One read of a run, built by the composition root over the pipeline. It
 * carries tenant, actor, mode, level and run; the engine gives only the
 * tool, its input and how many entries it may still pass on.
 */
export type RunRead = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  maxEntries: number,
  signal: AbortSignal,
) => Promise<RunCallOutcome>;

/** The results of one input, as the model gets them. */
export interface InputResults {
  readonly name: string;
  /** The result of each call, with the mark of the pipeline. */
  readonly values: readonly unknown[];
}

/** What the inputs gave, or why the run ends. */
export type InputsResult =
  | {
      readonly ok: true;
      readonly inputs: readonly InputResults[];
      /** What the model sees of each person, to the name for the report. */
      readonly persons: ReadonlyMap<string, string>;
      /** How many calls the run made. */
      readonly calls: number;
    }
  | {
      readonly ok: false;
      /**
       * The code of the read, `run_calls_exhausted` beyond the limits of
       * calls, or `run_items_exhausted` for an entry of a source that
       * would get a call after the input passed on all it may.
       */
      readonly code: ErrorCode | 'run_calls_exhausted' | 'run_items_exhausted';
      /** Whether a later try may pass (ADR 0034). */
      readonly transient: boolean;
      /** The name of the input. */
      readonly input: string;
    };

const dayMs = 86_400_000;
const relativeDay = /^([+-])(\d+)d$/;

// The day of the trigger plus the days of a relative day, as YYYY-MM-DD.
const dayFrom = (date: string, sign: string, days: number): string => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const at =
    Date.UTC(year, month - 1, day) + (sign === '-' ? -days : days) * dayMs;
  return new Date(at).toISOString().slice(0, 10);
};

// An own data property of a plain object, never through a getter.
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && 'value' in property
    ? property.value
    : undefined;
};

// The entries of the results of an input: the items of its list, or each
// result itself for a tool without a list.
const entriesOf = (
  values: readonly unknown[],
  list: string | undefined,
): readonly unknown[] =>
  list === undefined
    ? values
    : values.flatMap((value) => {
        const items = ownData(value, list);
        return Array.isArray(items) ? (items as readonly unknown[]) : [];
      });

// The input of one call: relative days as days, a list as a list, a field
// of the entry of the source in place of `{ field }`. Undefined when the
// entry lacks a value a call could take.
const inputOf = (
  prepared: PreparedInput,
  trigger: Trigger,
  entry: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  const input: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(prepared.input.params)) {
    if (isParamList(value)) {
      // A list of its own, as the input of a client is: the list of the
      // routine is frozen and shared by every run.
      input[name] = [...value];
    } else if (isParamField(value)) {
      const taken = ownData(entry, value.field);
      if (typeof taken !== 'string' && typeof taken !== 'number') {
        return undefined;
      }
      input[name] = taken;
    } else if (typeof value === 'string') {
      const days = relativeDay.exec(value);
      input[name] =
        days === null
          ? value
          : dayFrom(trigger.period.date, String(days[1]), Number(days[2]));
    } else {
      input[name] = value;
    }
  }
  return input;
};

/**
 * Reads every input of a prepared run.
 *
 * @param run - The prepared routine.
 * @param trigger - The trigger the run serves, for relative days.
 * @param read - The port of the composition root.
 * @param log - The logger of the run.
 * @param signal - The signal of the run.
 * @returns The results of each input with the names of the persons, or
 *   the first failure. It never throws for a failed read.
 * @example
 * ```ts
 * const read = await readInputs(prepared, trigger, port, log, signal);
 * if (!read.ok) return failed('input', read.code, !read.transient);
 * ```
 */
export async function readInputs(
  run: PreparedRun,
  trigger: Trigger,
  read: RunRead,
  log: Logger,
  signal: AbortSignal,
): Promise<InputsResult> {
  const done = new Map<string, readonly unknown[]>();
  const persons = new Map<string, string>();
  const results: InputResults[] = [];
  let calls = 0;
  for (const prepared of run.inputs) {
    const { input, facts } = prepared;
    const values: unknown[] = [];
    let entries = 0;
    let inputCalls = 0;
    const source = input.forEach;
    const sourceFacts = run.inputs.find(
      (item) => item.input.name === source,
    )?.facts;
    const sources =
      source === undefined
        ? [undefined]
        : entriesOf(done.get(source) ?? [], sourceFacts?.list);
    for (const entry of sources) {
      const base = inputOf(prepared, trigger, entry);
      if (base === undefined) continue;
      // An entry of the source that would get a call while the input may
      // pass on nothing more ends the run, so that no entry is left out
      // without a word; a cut inside a call says so with `more`.
      if (entries >= input.maxItems) {
        log.warn('run_read_limit', { count: entries });
        return {
          ok: false,
          code: 'run_items_exhausted',
          transient: false,
          input: input.name,
        };
      }
      // A page the routine names that is no number goes to the tool as it
      // is, so that the pipeline refuses it like any value of the wrong
      // kind instead of the run starting quietly at page 1.
      const counted =
        base['page'] === undefined || typeof base['page'] === 'number';
      let page = typeof base['page'] === 'number' ? base['page'] : 1;
      for (;;) {
        if (
          calls >= runReadLimits.callsPerRun ||
          inputCalls >= runReadLimits.callsPerInput
        ) {
          log.warn('run_read_limit', { count: calls });
          return {
            ok: false,
            code: 'run_calls_exhausted',
            transient: false,
            input: input.name,
          };
        }
        calls += 1;
        inputCalls += 1;
        const outcome = await read(
          input.tool,
          facts.paged && counted ? { ...base, page } : base,
          input.maxItems - entries,
          signal,
        );
        if (!outcome.ok) {
          log.warn('run_read_failed', { code: outcome.code });
          return {
            ok: false,
            code: outcome.code,
            transient: outcome.transient,
            input: input.name,
          };
        }
        values.push(outcome.data);
        entries += outcome.entries;
        for (const [key, name] of Object.entries(outcome.persons)) {
          if (name !== '' || !persons.has(key)) persons.set(key, name);
        }
        if (
          !facts.paged ||
          !counted ||
          !outcome.more ||
          entries >= input.maxItems
        ) {
          break;
        }
        page += 1;
      }
    }
    done.set(input.name, values);
    results.push(
      Object.freeze({ name: input.name, values: Object.freeze(values) }),
    );
  }
  return { ok: true, inputs: Object.freeze(results), persons, calls };
}
