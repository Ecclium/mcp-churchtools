/**
 * The schema of the answer of the model of a run (ADR 0033), made from the
 * blocks of the routine.
 *
 * Where it stands in a run: in the step of the model. The vendor gets the
 * JSON Schema, and the adapter and the guard check the answer with the
 * schema of zod, both from the same definition, so that what the vendor
 * is told and what the core takes never part.
 *
 * Why it is strict: an answer is an object with exactly the blocks of the
 * routine, each a list of at most its entries, each entry with exactly its
 * fields. A text has its length and one line, a number its range, a date
 * the form of a day that exists among the days of the run (`days.ts`),
 * and a person the form the model saw in its data: a pseudonym in
 * `strict`, an ID in `standard`. An injection in the data can change what
 * a field says, not how many fields there are. No part of the schema
 * changes a value, because the guard checks the answer a second time with
 * it.
 *
 * @packageDocumentation
 */
import {
  type ModelRedaction,
  pseudonymPattern,
} from '@ecclium/mcp-churchtools-core';
import type { ModelOutputSpec } from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

import type { RoutineBlock, RoutineField } from '../routine/schema.js';
import { isDay, type RunDays } from './days.js';

/** A value of a field of an answer, as the schema takes it. */
export type RunAnswerValue = string | number;

/** An answer of the model: each block a list of entries. */
export type RunAnswer = Readonly<
  Record<string, readonly Readonly<Record<string, RunAnswerValue>>[]>
>;

/** The name of the schema of an answer, as the vendor gets it. */
export const runAnswerName = 'routine_output';

// The highest ID of an object of ChurchTools, as the policy takes it.
const maxId = 2_147_483_647;

// One line: no line feed, no carriage return and no separator of lines or
// paragraphs of Unicode, which a reader would take for a new line.
const oneLine = /^[^\n\r\u2028\u2029]*$/u;

// The most years the pattern of a date names one by one.
const maxPatternYears = 10;

// The years of the days in the pattern of the JSON Schema, so that a
// vendor that follows the pattern while the model writes cannot even
// begin another year. Over more years the pattern takes any year, and the
// check of the core alone holds the days.
const yearsOf = (days: RunDays | undefined): string => {
  if (days === undefined) return '\\d{4}';
  const first = Number(days.first.slice(0, 4));
  const last = Number(days.last.slice(0, 4));
  if (last - first >= maxPatternYears) return '\\d{4}';
  const years = Array.from({ length: last - first + 1 }, (_, index) =>
    String(first + index).padStart(4, '0'),
  );
  return `(?:${years.join('|')})`;
};

/** The metadata the JSON Schema of an answer carries for a field. */
type FieldMeta = { readonly description: string };

const dateSchema = (
  days: RunDays | undefined,
  metadata: z.core.$ZodRegistry<FieldMeta>,
) => {
  const schema = z
    .string()
    .regex(new RegExp(`^${yearsOf(days)}-(\\d{2})-(\\d{2})$`))
    .refine(isDay)
    .refine(
      (value) =>
        days !== undefined && value >= days.first && value <= days.last,
    );
  metadata.add(schema, {
    description:
      days === undefined
        ? 'No day of this run fits: leave out every entry with a date.'
        : `A day from ${days.first} to ${days.last}, as YYYY-MM-DD.`,
  });
  return schema;
};

const fieldSchema = (
  field: RoutineField,
  level: ModelRedaction,
  date: () => z.ZodType<string>,
) => {
  switch (field.type) {
    case 'text':
      return z.string().max(field.maxLength).regex(oneLine);
    case 'integer':
      return z.int().min(field.min).max(field.max);
    case 'date':
      return date();
    case 'person':
      return level === 'strict'
        ? z.string().regex(new RegExp(pseudonymPattern, 'u'))
        : z.int().min(1).max(maxId);
  }
};

/**
 * Makes the schema of the answer of a run from the blocks of its routine.
 *
 * @param blocks - The blocks of the routine by name.
 * @param level - The level of the data for the model, which decides what a
 *   field of a person holds.
 * @param days - The days of the run, the only days a date may name; none
 *   when the run names no day, so that no date fits.
 * @returns The name, the JSON Schema for the vendor and the check of the
 *   answer, frozen.
 * @example
 * ```ts
 * const days = runDaysOf(prepared, trigger, read.inputs);
 * const output = outputSpecOf(routine.generate.blocks, 'strict', days);
 * await model.generate({ system, parts, output, maxOutputTokens }, signal);
 * ```
 */
export function outputSpecOf(
  blocks: Readonly<Record<string, RoutineBlock>>,
  level: ModelRedaction,
  days: RunDays | undefined,
): ModelOutputSpec<RunAnswer> {
  // A registry of this call, not the global one of zod, so that the days
  // of one run never stay in a module (ADR 0051).
  const metadata = z.registry<FieldMeta>();
  const date = () => dateSchema(days, metadata);
  const schema = z.strictObject(
    Object.fromEntries(
      Object.entries(blocks).map(([name, block]) => [
        name,
        z
          .array(
            z.strictObject(
              Object.fromEntries(
                Object.entries(block.fields).map(([fieldName, field]) => [
                  fieldName,
                  fieldSchema(field, level, date),
                ]),
              ),
            ),
          )
          .max(block.maxItems),
      ]),
    ),
  );
  // The keyword of the version of JSON Schema says nothing to a vendor,
  // and some refuse keywords they do not know.
  const jsonSchema: Record<string, unknown> = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    metadata,
  });
  delete jsonSchema['$schema'];
  return Object.freeze({
    name: runAnswerName,
    jsonSchema,
    validate: schema,
  });
}
