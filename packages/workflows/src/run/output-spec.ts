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
 * the form of a day that exists, and a person the form the model saw in
 * its data: a pseudonym in `strict`, an ID in `standard`. An injection in
 * the data can change what a field says, not how many fields there are.
 * No part of the schema changes a value, because the guard checks the
 * answer a second time with it.
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

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

// Whether a day of the form YYYY-MM-DD exists in the calendar.
const isDay = (value: string): boolean => {
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
};

const fieldSchema = (field: RoutineField, level: ModelRedaction) => {
  switch (field.type) {
    case 'text':
      return z.string().max(field.maxLength).regex(oneLine);
    case 'integer':
      return z.int().min(field.min).max(field.max);
    case 'date':
      return z.string().regex(dayPattern).refine(isDay);
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
 * @returns The name, the JSON Schema for the vendor and the check of the
 *   answer, frozen.
 * @example
 * ```ts
 * const output = outputSpecOf(routine.generate.blocks, 'strict');
 * await model.generate({ system, parts, output, maxOutputTokens }, signal);
 * ```
 */
export function outputSpecOf(
  blocks: Readonly<Record<string, RoutineBlock>>,
  level: ModelRedaction,
): ModelOutputSpec<RunAnswer> {
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
                  fieldSchema(field, level),
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
  });
  delete jsonSchema['$schema'];
  return Object.freeze({
    name: runAnswerName,
    jsonSchema,
    validate: schema,
  });
}
