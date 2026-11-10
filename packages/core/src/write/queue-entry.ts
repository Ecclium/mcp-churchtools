/**
 * The entry of the queue of approvals as the write guard makes it from a
 * sealed plan (ADR 0031).
 *
 * Where it stands in the way of a write: when the pipeline finds that a
 * plan goes to the queue instead of a question or the echo, it hands the
 * plan and its text here. Only the write guard reads a sealed plan, so
 * this module turns it into the plain record that the queue seals: tool,
 * origin and metadata, the actor of the wish, the checked intent with its
 * texts, the hash of the plan, the target, the summary and the diff, and
 * why it waits. An approval of the operator plans the write again from
 * this record with the actor of the wish, and commits it only when the
 * hash is the same (ADR 0029).
 *
 * @packageDocumentation
 */
import type { PlannedWrite } from '@ecclium/mcp-churchtools-plugin-api';

import type { QueueEntryContent, QueueReason } from '../queue/seal.js';
import type { ConfirmationText } from './confirmation-text.js';
import { readPlan } from './sealed-plan.js';

/**
 * Makes the content of an entry of the queue from a sealed plan.
 *
 * @param plan - The sealed plan, as the tool returned it.
 * @param text - The text of the confirmation of the plan.
 * @param reason - Why the plan goes to the queue.
 * @param queuedAt - When, in milliseconds since the Unix epoch.
 * @returns The content, frozen.
 * @throws {TypeError} For a value that is no sealed plan.
 * @example
 * ```ts
 * const content = queueEntryOf(plan, text, 'no_question', clock.now());
 * await queue.enqueue(ctx, { id: eventId, day, content });
 * ```
 */
export function queueEntryOf(
  plan: PlannedWrite,
  text: ConfirmationText,
  reason: QueueReason,
  queuedAt: number,
): QueueEntryContent {
  const view = readPlan(plan);
  if (view === undefined) throw new TypeError('No sealed plan.');
  const { rules } = view;
  return Object.freeze({
    tool: view.tool,
    origin: view.origin,
    // The metadata as the core derived it for the plan, the strictest of
    // what the tool and the intent say.
    toolMeta: Object.freeze({
      sensitivity: rules.sensitivity,
      unattended: rules.unattended,
      reversible: rules.reversible,
    }),
    actor: view.actor,
    intent: view.intent,
    planHash: view.planHash,
    target: Object.freeze({ kind: rules.target.kind, key: rules.target.key }),
    summary: text.summary,
    ...(text.title === undefined ? {} : { title: text.title }),
    diff: text.diff,
    reason,
    queuedAt,
    ...(view.day === undefined ? {} : { plannedOn: view.day }),
    // The run a write of a routine comes from, so that an approval judges
    // it against the entries of its routine and writes the same marking
    // (ADR 0032).
    ...(view.run === undefined
      ? {}
      : {
          run: Object.freeze({
            routine: view.run.routine,
            period: view.run.period,
            contacts: view.run.contacts,
          }),
        }),
  });
}
