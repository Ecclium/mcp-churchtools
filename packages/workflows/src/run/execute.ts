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

import type { RoutineOutput } from '../routine/schema.js';
import { checkAnswer } from './answer.js';
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
  /** The model of the alias of the routine, behind its guard. */
  readonly model: GuardedModel;
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
      /** The model that filled the blocks. */
      readonly provider: ProviderInfo;
      readonly attempts: 1 | 2;
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
       * `run_items_exhausted`, `run_person_unknown` and
       * `run_content_refused` of the engine.
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

  const read = await readInputs(run, trigger, ports.read, log, signal);
  if (!read.ok) {
    return failed('input', read.code, !read.transient, { input: read.input });
  }
  // The prepared routine has a step with a model, so the loader read its
  // prompt.
  const generate = routine.generate as NonNullable<typeof routine.generate>;
  const contacts = runContactKeys(
    ports.policy,
    read.inputs.flatMap((input) => input.values),
  );

  const asked = clock.now();
  let answer;
  try {
    answer = await ports.model.generate(
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
    return failed(
      'answer',
      checked.unknownPerson ? 'run_person_unknown' : 'run_content_refused',
      true,
      checked.violations.length === 0 ? {} : { violations: checked.violations },
    );
  }

  const period = trigger.period[routine.output.period];
  const section = checkRunSection(
    renderSection(loaded.template, checked.blocks, period),
    contacts,
  );
  if (!section.ok) {
    log.warn('run_section_refused');
    return failed('content', 'run_content_refused', true, {
      violations: section.violations,
    });
  }
  log.info('run_rendered', {
    count: checked.entries,
    durationMs: since(start),
  });

  return Object.freeze({
    kind: 'rendered',
    routineId: routine.id,
    period,
    section: section.text,
    output: routine.output,
    ...(run.target === undefined ? {} : { target: run.target }),
    ...(run.credential === undefined ? {} : { credential: run.credential }),
    provider: ports.model.info,
    attempts: answer.attempts,
    ...(answer.usage === undefined ? {} : { usage: answer.usage }),
    calls: read.calls,
    ...(run.preview === true ? { preview: true } : {}),
  });
}
