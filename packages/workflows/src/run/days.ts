/**
 * The days of a run, the only days a date in the answer of its model may
 * name (ADR 0033).
 *
 * Where it stands in a run: after the inputs, before the model. The engine
 * names the first and the last day to the model in a rule after the system
 * text and in the output schema, and the schema takes no other day.
 *
 * Why: a model may write the right day and month with a wrong year, as
 * one did in a draft of appointments at a test instance, while a field of
 * the kind date was only checked to be a day that exists. The days of a
 * run are those its routine names in the parameters of its inputs, such
 * as `+7d` and `+35d`, and every day that stands in the data as a value
 * of its own, such as the start of an appointment of several days that
 * began before the first of them. Text people write stands in the data
 * envelope and never counts, so that a title such as «1800-01-01» cannot
 * widen the days. One day more on each side, because ChurchTools gives
 * moments in UTC and the model writes the day in the zone of the parish.
 *
 * @packageDocumentation
 */
import type { Trigger } from '@ecclium/mcp-churchtools-core';
import { dateOrDateTimePattern } from '@ecclium/mcp-churchtools-plugin-api';

import type { PreparedRun } from './prepare.js';

/** The first and the last day a date of an answer may name, as YYYY-MM-DD. */
export interface RunDays {
  readonly first: string;
  readonly last: string;
}

const dayMs = 86_400_000;
const relativeDay = /^([+-])(\d+)d$/;
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a text is a day of the form YYYY-MM-DD that exists in the
 * calendar.
 *
 * @param value - The text.
 * @returns Whether it is such a day.
 * @example
 * ```ts
 * isDay('2026-11-09'); // true
 * isDay('2026-02-30'); // false
 * ```
 */
export function isDay(value: string): boolean {
  const match = dayPattern.exec(value);
  if (match === null) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// The day so many days after another, as YYYY-MM-DD.
const shift = (day: string, days: number): string => {
  const [year, month, date] = day.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, date) + days * dayMs)
    .toISOString()
    .slice(0, 10);
};

/**
 * The day a relative day of a routine stands for, such as `+14d`: so many
 * days after another day, never the day of the run (ADR 0034).
 *
 * @param value - The value of a parameter.
 * @param from - The day it counts from, as YYYY-MM-DD: the day of the
 *   trigger in the zone of the configuration.
 * @returns The day as YYYY-MM-DD, or undefined for any other value.
 * @example
 * ```ts
 * relativeDayOf('+14d', '2026-11-09'); // '2026-11-23'
 * relativeDayOf('Gottesdienst', '2026-11-09'); // undefined
 * ```
 */
export function relativeDayOf(value: string, from: string): string | undefined {
  const match = relativeDay.exec(value);
  if (match === null) return undefined;
  const days = Number(match[2]);
  return shift(from, match[1] === '-' ? -days : days);
}

/**
 * The days of a run: from the first to the last day its parameters and
 * its data name, with one day more on each side.
 *
 * @param run - The prepared routine, for the parameters of its inputs.
 * @param trigger - The trigger, for the relative days.
 * @param inputs - What the inputs read, with the mark of the pipeline.
 * @returns The days, or undefined when neither the parameters nor the
 *   data name a day, so that no date can be right.
 * @example
 * ```ts
 * const days = runDaysOf(prepared, trigger, read.inputs);
 * const output = outputSpecOf(blocks, 'strict', days);
 * ```
 */
export function runDaysOf(
  run: PreparedRun,
  trigger: Trigger,
  inputs: readonly { readonly values: readonly unknown[] }[],
): RunDays | undefined {
  let first: string | undefined;
  let last: string | undefined;
  const take = (day: string): void => {
    if (first === undefined || day < first) first = day;
    if (last === undefined || day > last) last = day;
  };

  // A day the routine names: relative to the trigger, or as it stands. A
  // list and a field of another input give their values from the data.
  for (const { input } of run.inputs) {
    for (const value of Object.values(input.params)) {
      if (typeof value !== 'string') continue;
      const day = relativeDayOf(value, trigger.period.date);
      if (day !== undefined) take(day);
      else if (isDay(value)) take(value);
    }
  }

  // A day in the data: a value of its own that is a day or a moment, read
  // through own data properties, never through a getter. A text of people
  // starts with the mark of its envelope and is never one.
  const stack: unknown[] = inputs.flatMap((input) => input.values);
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      const day = value.slice(0, 10);
      if (dateOrDateTimePattern.test(value) && isDay(day)) take(day);
    } else if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property !== undefined && 'value' in property) {
          stack.push(property.value);
        }
      }
    }
  }

  if (first === undefined || last === undefined) return undefined;
  return Object.freeze({ first: shift(first, -1), last: shift(last, 1) });
}

/**
 * The rule on dates that follows the system text of the core for a
 * routine with a field of the kind date. It holds only days, no text of
 * ChurchTools, so that it says what the schema takes also to a model whose
 * vendor does not show the schema.
 *
 * @param days - The days of the run, or undefined for none.
 * @returns One line in English, like the system text.
 * @example
 * ```ts
 * datesRule({ first: '2026-11-15', last: '2026-12-15' });
 * // 'Every date in your answer is a day from 2026-11-15 to 2026-12-15, ...'
 * ```
 */
export function datesRule(days: RunDays | undefined): string {
  return days === undefined
    ? 'The data of this run name no day. Write no entry that needs a date.'
    : `Every date in your answer is a day from ${days.first} to ${days.last}, written as YYYY-MM-DD and taken from the data.`;
}
