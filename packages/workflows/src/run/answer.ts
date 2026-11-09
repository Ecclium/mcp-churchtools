/**
 * The check of the answer of the model of a run (ADR 0030, ADR 0033).
 *
 * Where it stands in a run: after the model, whose answer the adapter and
 * the guard checked against the schema of the blocks, and before the
 * template. Every person the answer names must be one the run read, by
 * what the model saw of it, so that the model cannot bring a person in.
 * Every text goes through the content policy on its own, with the contact
 * values of the policy and of the data of the model; a pseudonym in a
 * text counts as a mask and refuses it, so that none stands in a report.
 * So does the name of every person, which comes from ChurchTools.
 *
 * What it gives the template: each value as plain text in its final form,
 * a text in the normal form of the content policy, a number as digits, a
 * day as `09.11.2026` and a person as the name ChurchTools gave in the
 * level `standard`. The template sets each of them as plain text.
 *
 * @packageDocumentation
 */
import { checkRunText } from '@ecclium/mcp-churchtools-core';
import {
  type ContentViolationKind,
  contentViolationKinds,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { RoutineBlock } from '../routine/schema.js';
import type { RunAnswer } from './output-spec.js';

/** The text for a person the data name without a name. */
export const unnamedPerson = '(ohne Namen)';

/** The values of each block, as plain text for the template. */
export type FilledBlocks = Readonly<
  Record<string, readonly Readonly<Record<string, string>>[]>
>;

/** The filled blocks, or why the answer does not count. */
export type AnswerCheck =
  | {
      readonly ok: true;
      readonly blocks: FilledBlocks;
      readonly entries: number;
    }
  | {
      readonly ok: false;
      /** How many fields failed. */
      readonly fields: number;
      /** Whether a person was not one of the data. */
      readonly unknownPerson: boolean;
      /** Why the content policy refused texts, in its order, maybe none. */
      readonly violations: readonly ContentViolationKind[];
    };

/**
 * Checks the answer of a model and gives the values for the template.
 *
 * @param answer - The answer, checked against the schema of the blocks.
 * @param blocks - The blocks of the routine.
 * @param persons - What the model saw of each person, to its name.
 * @param contacts - The keys of the contact values a text may hold.
 * @returns The filled blocks with the number of their entries, or how
 *   many fields failed and why.
 * @example
 * ```ts
 * const checked = checkAnswer(answer, blocks, read.persons, contacts);
 * if (!checked.ok) return refused(checked.violations);
 * ```
 */
export function checkAnswer(
  answer: RunAnswer,
  blocks: Readonly<Record<string, RoutineBlock>>,
  persons: ReadonlyMap<string, string>,
  contacts: ReadonlySet<string>,
): AnswerCheck {
  const filled: Record<string, readonly Readonly<Record<string, string>>[]> =
    {};
  const violations = new Set<ContentViolationKind>();
  let failed = 0;
  let unknownPerson = false;
  let entries = 0;
  for (const [blockName, block] of Object.entries(blocks)) {
    const list: Readonly<Record<string, string>>[] = [];
    for (const item of answer[blockName] ?? []) {
      const values: Record<string, string> = {};
      for (const [fieldName, field] of Object.entries(block.fields)) {
        const value = item[fieldName];
        switch (field.type) {
          case 'text': {
            const checked = checkRunText(String(value), contacts);
            if (checked.ok) {
              values[fieldName] = checked.text;
            } else {
              failed += 1;
              for (const kind of checked.violations) violations.add(kind);
            }
            break;
          }
          case 'integer':
            values[fieldName] = String(value);
            break;
          case 'date': {
            const [year, month, day] = String(value).split('-');
            values[fieldName] =
              `${String(day)}.${String(month)}.${String(year)}`;
            break;
          }
          case 'person': {
            const name = persons.get(String(value));
            if (name === undefined) {
              failed += 1;
              unknownPerson = true;
              break;
            }
            if (name === '') {
              values[fieldName] = unnamedPerson;
              break;
            }
            // A name comes from ChurchTools, where a person may edit it, so
            // it passes the same check as a text of the model: one line in
            // the normal form, no sign of Markdown, no mask and no note of
            // the core, before the template sets it as plain text.
            const checked = checkRunText(name, contacts);
            if (checked.ok) {
              values[fieldName] = checked.text;
            } else {
              failed += 1;
              for (const kind of checked.violations) violations.add(kind);
            }
          }
        }
      }
      list.push(Object.freeze(values));
    }
    entries += list.length;
    filled[blockName] = Object.freeze(list);
  }
  if (failed > 0) {
    return Object.freeze({
      ok: false,
      fields: failed,
      unknownPerson,
      violations: Object.freeze(
        contentViolationKinds.filter((kind) => violations.has(kind)),
      ),
    });
  }
  return Object.freeze({ ok: true, blocks: Object.freeze(filled), entries });
}
