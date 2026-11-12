/**
 * The engine of a run of a routine, up to before the write (ADR 0033).
 *
 * Where it stands in a run: after the preparation and the trigger, which
 * the runner settles, and before the write, which the write guard does
 * with a proof of the policy. In between, in this order and nowhere else:
 *
 * 1. read the inputs through the port of the composition root,
 * 2. call the model behind its guard, with the system text of the core,
 *    the prompt file of the routine and the data in their blocks, within
 *    a fixed deadline and the limit of tokens of the routine,
 * 3. check the answer: every person one of the data, every text through
 *    the content policy with the contact values of the policy and of the
 *    data,
 * 4. render the blocks into the template and check the whole section once
 *    more.
 *
 * A routine with checks of the core has neither inputs nor a model: the
 * checks read through the same port and fill the blocks in place of steps
 * 1 to 3, and step 4 is the same.
 *
 * A run never writes here. What it gives is the section with what the
 * write needs: the period, the origin of the marking, the target and its
 * entry of the policy. A trial run is this call and nothing after it.
 *
 * A failure names its step, its code and whether a later try may pass, so
 * that the runner closes the trigger or tries again (ADR 0034). No text of
 * ChurchTools, of the model or of the vendor is in it.
 *
 * @packageDocumentation
 */
import {
  checkRunSection,
  type GuardedModel,
  isTransientRunCode,
  type Policy,
  runContactKeys,
  runSystemText,
  type Trigger,
  type UnattendedEntry,
} from '@ecclium/mcp-churchtools-core';
import {
  type Clock,
  type ContentViolationKind,
  isEccliumError,
  type Logger,
  type ProviderInfo,
  type TokenUsage,
} from '@ecclium/mcp-churchtools-plugin-api';

import { checkBlockFields } from '../routine/check.js';
import type { RoutineCheckName, RoutineOutput } from '../routine/schema.js';
import { checkAnswer, type FilledBlocks } from './answer.js';
import { type CheckContext, hiddenTitle, runChecks } from './checks.js';
import { readInputs, type RunRead } from './inputs.js';
import { outputSpecOf } from './output-spec.js';
import type { PreparedRun } from './prepare.js';
import { renderSection } from './render.js';

/** The limits of a run, frozen. */
export const runLimits = Object.freeze({
  /**
   * The longest call of the model, both attempts together, in
   * milliseconds: the transport to a model allows 300 seconds per request.
   */
  modelMs: 600_000,
} as const);

/** What the composition root gives a run. */
export interface RunPorts {
  /** Reads with the actor of the routine and the level of the model. */
  readonly read: RunRead;
  /**
   * The model of the alias of the routine, behind its guard; none for a
   * routine with checks of the core.
   */
  readonly model?: GuardedModel;
  /** What the checks of the core need, for a routine with checks. */
  readonly checks?: CheckContext;
  /** The checked policy. */
  readonly policy: Policy;
  /** The logger of the run. */
  readonly log: Logger;
  /** The clock of the core. */
  readonly clock: Clock;
}

/** The step a run ended in. */
export type RunStep = 'input' | 'model' | 'answer' | 'content';

/** How a run ended before the write. */
export type RunResult =
  | {
      /** The section is rendered and passed every check. */
      readonly kind: 'rendered';
      readonly routineId: string;
      /** The period of the run, such as `2026-W46`. */
      readonly period: string;
      /** The section in the form to write, without the line of the marking. */
      readonly section: string;
      /** Where it goes. */
      readonly output: RoutineOutput;
      /** The entry of the policy that allows a target in ChurchTools. */
      readonly target?: UnattendedEntry;
      /** The alias of the account, when the policy names one. */
      readonly credential?: string;
      /** The model that filled the blocks; none for checks of the core. */
      readonly provider?: ProviderInfo;
      /** The calls of the model; none for checks of the core. */
      readonly attempts?: 1 | 2;
      readonly usage?: TokenUsage;
      /** How many reads the run made. */
      readonly calls: number;
      /** Present for a routine prepared only for a preview, which never writes. */
      readonly preview?: true;
    }
  | {
      readonly kind: 'failed';
      readonly step: RunStep;
      /**
       * The code: of a read or the model, or `run_calls_exhausted`,
       * `run_items_exhausted`, `run_person_unknown`,
       * `run_page_date_missing` and `run_content_refused` of the engine.
       */
      readonly code: string;
      /** Whether a later try would end the same, so the trigger closes. */
      readonly final: boolean;
      /** The input whose read failed. */
      readonly input?: string;
      /** Why the content policy refused, for a step `answer` or `content`. */
      readonly violations?: readonly ContentViolationKind[];
    };

const failed = (
  step: RunStep,
  code: string,
  final: boolean,
  more: {
    readonly input?: string;
    readonly violations?: readonly ContentViolationKind[];
  } = {},
): RunResult => Object.freeze({ kind: 'failed', step, code, final, ...more });

/**
 * Runs a prepared routine up to before its write.
 *
 * @param run - The prepared routine.
 * @param trigger - The trigger the run serves.
 * @param ports - Read, model, policy, logger and clock of the run.
 * @param signal - Aborts the run.
 * @returns The rendered section or how the run ended. It never throws for
 *   a failure of ChurchTools, the model or the checks.
 * @example
 * ```ts
 * const result = await executeRun(prepared, trigger, ports, signal);
 * if (result.kind === 'rendered') show(result.section);
 * ```
 */
export async function executeRun(
  run: PreparedRun,
  trigger: Trigger,
  ports: RunPorts,
  signal: AbortSignal,
): Promise<RunResult> {
  const { loaded } = run;
  const { routine } = loaded;
  const { log, clock } = ports;
  const start = clock.now();
  const since = (from: number): number =>
    Math.min(Math.max(Math.round(clock.now() - from), 0), 86_400_000);

  // Renders the filled blocks, checks the whole section and gives what
  // the write needs.
  const rendered = (
    blocks: FilledBlocks,
    entries: number,
    contacts: ReadonlySet<string>,
    calls: number,
    model?: {
      readonly provider: ProviderInfo;
      readonly attempts: 1 | 2;
      readonly usage?: TokenUsage;
    },
  ): RunResult => {
    const period = trigger.period[routine.output.period];
    const section = checkRunSection(
      renderSection(loaded.template, blocks, period),
      contacts,
    );
    if (!section.ok) {
      log.warn('run_section_refused');
      return failed('content', 'run_content_refused', true, {
        violations: section.violations,
      });
    }
    log.info('run_rendered', { count: entries, durationMs: since(start) });
    return Object.freeze({
      kind: 'rendered',
      routineId: routine.id,
      period,
      section: section.text,
      output: routine.output,
      ...(run.target === undefined ? {} : { target: run.target }),
      ...(run.credential === undefined ? {} : { credential: run.credential }),
      ...(model === undefined
        ? {}
        : {
            provider: model.provider,
            attempts: model.attempts,
            ...(model.usage === undefined ? {} : { usage: model.usage }),
          }),
      calls,
      ...(run.preview === true ? { preview: true } : {}),
    });
  };

  // The blocks of the checks of the core, each entry fitted to its line of
  // the template: an entry that the content policy refuses there, alone in
  // its block, gives way to the fixed text in each of its texts, so that
  // a title next to a word of the template, such as one that ends in
  // «mailto» before a colon, cannot fail every run (ADR 0033). A date
  // stays; the core wrote it.
  const fitTemplate = (
    blocks: FilledBlocks,
    contacts: ReadonlySet<string>,
  ): FilledBlocks => {
    const period = trigger.period[routine.output.period];
    const fits = (candidate: FilledBlocks): boolean =>
      checkRunSection(
        renderSection(loaded.template, candidate, period),
        contacts,
      ).ok;
    if (fits(blocks)) return blocks;
    const fitted: Record<string, readonly Readonly<Record<string, string>>[]> =
      {};
    for (const [name, entries] of Object.entries(blocks)) {
      fitted[name] = Object.freeze(
        entries.map((entry) => {
          if (fits({ [name]: [entry] })) return entry;
          const fields = checkBlockFields[name as RoutineCheckName];
          const hidden: Record<string, string> = {};
          for (const [field, value] of Object.entries(entry)) {
            hidden[field] =
              fields[field]?.type === 'date' ? value : hiddenTitle;
          }
          return Object.freeze(hidden);
        }),
      );
    }
    return Object.freeze(fitted);
  };

  // A routine with checks of the core: no inputs and no model. The checks
  // read through the same port and fill the blocks; a report may hold only
  // the contact values of the policy (ADR 0033).
  if (routine.checks !== undefined) {
    // The composition root gives the context with every routine with
    // checks; without it the run cannot tell its links.
    if (ports.checks === undefined) return failed('input', 'internal', true);
    const checked = await runChecks(
      routine.checks,
      ports.read,
      ports.checks,
      trigger.at,
      log,
      signal,
    );
    if (!checked.ok) {
      return failed('input', checked.code, !checked.transient);
    }
    const contacts = runContactKeys(ports.policy, []);
    return rendered(
      fitTemplate(checked.blocks, contacts),
      checked.entries,
      contacts,
      checked.calls,
    );
  }

  const read = await readInputs(run, trigger, ports.read, log, signal);
  if (!read.ok) {
    return failed('input', read.code, !read.transient, { input: read.input });
  }
  // The prepared routine has a step with a model, so the loader read its
  // prompt, and the composition root gives the model of its alias.
  const generate = routine.generate as NonNullable<typeof routine.generate>;
  const { model } = ports;
  if (model === undefined) return failed('model', 'internal', true);
  const contacts = runContactKeys(
    ports.policy,
    read.inputs.flatMap((input) => input.values),
  );

  const asked = clock.now();
  let answer;
  try {
    answer = await model.generate(
      {
        system: runSystemText,
        parts: [
          { kind: 'instructions', text: loaded.prompt as string },
          ...read.inputs.map((input) => ({
            kind: 'data' as const,
            name: input.name,
            value: input.values,
          })),
        ],
        output: outputSpecOf(generate.blocks, run.redaction),
        maxOutputTokens: generate.maxOutputTokens,
      },
      AbortSignal.any([signal, AbortSignal.timeout(runLimits.modelMs)]),
    );
  } catch (error) {
    // The guard throws only an error of Ecclium; anything else is a fault.
    const code = isEccliumError(error) ? error.code : 'internal';
    log.warn('run_model_failed', { code, durationMs: since(asked) });
    return failed('model', code, !isTransientRunCode(code));
  }
  log.info('run_model_answered', {
    attempt: answer.attempts,
    durationMs: since(asked),
  });

  const checked = checkAnswer(
    answer.value,
    generate.blocks,
    read.persons,
    contacts,
  );
  if (!checked.ok) {
    log.warn('run_answer_refused', { count: checked.fields });
    // A breach of the content policy outweighs an unknown person, so that
    // the audit says it was refused and names why (ADR 0030).
    return failed(
      'answer',
      checked.unknownPerson && checked.violations.length === 0
        ? 'run_person_unknown'
        : 'run_content_refused',
      true,
      checked.violations.length === 0 ? {} : { violations: checked.violations },
    );
  }

  return rendered(checked.blocks, checked.entries, contacts, read.calls, {
    provider: model.info,
    attempts: answer.attempts,
    ...(answer.usage === undefined ? {} : { usage: answer.usage }),
  });
}
