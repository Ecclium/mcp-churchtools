/**
 * Preparing a run of a routine (ADR 0033): the checks the loader cannot
 * make, because they need the tools of the server, the policy and the
 * models.
 *
 * Where it stands in a run: first, before anything is read. A routine
 * that names a tool that is not a read tool stable for routines, a
 * parameter the tool does not know, a field an entry does not have, a
 * target the policy does not list, two accounts or a model without a
 * provider does not start. Each problem is reported with its code and the
 * path of its field, never with a value of the routine.
 *
 * What it settles for the run: the level of redaction of the data for the
 * model, which only the policy may lower, the entry of the policy for the
 * target and the alias of the account the run reads and writes with.
 *
 * @packageDocumentation
 */
import {
  modelRedactionOf,
  type ModelRedaction,
  type Policy,
  type RunToolFacts,
  type UnattendedEntry,
} from '@ecclium/mcp-churchtools-core';

import type { LoadedRoutine } from '../routine/loader.js';
import type { RoutineInput } from '../routine/schema.js';

/** Why a routine does not start, frozen. */
export const runPrepareCodes = Object.freeze([
  'run_checks_pending',
  'run_tool_unknown',
  'run_tool_unfit',
  'run_param_unknown',
  'run_param_days',
  'run_field_unknown',
  'run_credential_mixed',
  'run_target_unlisted',
  'run_model_unknown',
] as const);

/** Why a routine does not start. */
export type RunPrepareCode = (typeof runPrepareCodes)[number];

/** What the preparation needs besides the routine. */
export interface RunPrepareContext {
  /** The facts of a tool of the server, or undefined for none. */
  readonly tool: (name: string) => RunToolFacts | undefined;
  /** The checked policy. */
  readonly policy: Policy;
  /** The aliases of the models the configuration offers. */
  readonly models: ReadonlySet<string>;
  /**
   * Whether the run is a preview, which writes nothing: then a target in
   * the wiki needs no entry of the policy yet, so that the operator sees
   * the section before writing the entry (ADR 0033). Every other check
   * holds.
   */
  readonly preview?: boolean;
}

/** An input with the facts of its tool. */
export interface PreparedInput {
  readonly input: RoutineInput;
  readonly facts: RunToolFacts;
}

/** A routine ready to run, deeply frozen. */
export interface PreparedRun {
  readonly loaded: LoadedRoutine;
  /** The inputs in their order, each with the facts of its tool. */
  readonly inputs: readonly PreparedInput[];
  /** The level of the data for the model. */
  readonly redaction: ModelRedaction;
  /** The alias of the model. */
  readonly model: string;
  /** The entries of the routine in the unattended part of the policy. */
  readonly entries: readonly UnattendedEntry[];
  /** The entry that allows the target, for a target in ChurchTools. */
  readonly target?: UnattendedEntry;
  /**
   * The alias of the account the run reads and writes with, or undefined
   * for the account of the runner, when the policy has no entry.
   */
  readonly credential?: string;
  /**
   * Present for a routine prepared only for a preview: it may lack the
   * entry of its target, and nothing may write its section.
   */
  readonly preview?: true;
}

/** The prepared routine, or why it does not start. */
export type RunPrepareResult =
  | { readonly ok: true; readonly run: PreparedRun }
  | {
      readonly ok: false;
      readonly code: RunPrepareCode;
      /** The path of the field, such as `inputs[1].params.eventId`. */
      readonly field?: string;
    };

/** The alias of the account of a routine, or that its entries differ. */
export type RunCredential =
  | {
      readonly ok: true;
      /** The alias, or undefined for a routine without an entry. */
      readonly credential?: string;
    }
  | { readonly ok: false };

/**
 * The alias of the account of a routine, from the entries of the routine
 * in the unattended part of the policy. The composition root takes it
 * from the policy itself, never from its caller, so that no run reads or
 * writes with another account than the policy names (ADR 0033).
 *
 * @param policy - The checked policy of the configuration.
 * @param routineId - The ID of the routine.
 * @returns The alias, none for a routine without an entry, or not ok when
 *   the entries of the routine name two aliases.
 * @example
 * ```ts
 * const settled = runCredentialOf(config.policy, 'dienstplan-report');
 * ```
 */
export function runCredentialOf(
  policy: Policy,
  routineId: string,
): RunCredential {
  const aliases = new Set(
    policy.unattended
      .filter((entry) => entry.routine === routineId)
      .map((entry) => entry.credential),
  );
  if (aliases.size > 1) return Object.freeze({ ok: false });
  const [credential] = aliases;
  return Object.freeze(
    credential === undefined ? { ok: true } : { ok: true, credential },
  );
}

/** The most days a relative day of a parameter reaches, either way. */
export const maxRelativeDays = 366;

// A relative day, such as +14d or -7d.
const relativeDay = /^[+-](\d+)d$/;

const refuse = (code: RunPrepareCode, field?: string): RunPrepareResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(field === undefined ? {} : { field }),
  });

// The first problem of the parameters of an input, with the path of its
// field: a name the tool does not take, a relative day too far away, or a
// field the entries of its source do not have.
const paramProblem = (
  input: RoutineInput,
  facts: RunToolFacts,
  at: string,
  source: RunToolFacts | undefined,
): readonly [RunPrepareCode, string] | undefined => {
  for (const [name, value] of Object.entries(input.params)) {
    const field = `${at}.params.${name}`;
    if (!facts.params.includes(name)) return ['run_param_unknown', field];
    if (typeof value === 'string') {
      const days = relativeDay.exec(value);
      if (days !== null && Number(days[1]) > maxRelativeDays) {
        return ['run_param_days', field];
      }
    } else if (
      typeof value === 'object' &&
      // The check of the routine allows a field only with forEach.
      !(source?.entryFields.includes(value.field) ?? false)
    ) {
      return ['run_field_unknown', field];
    }
  }
  return undefined;
};

// Whether an entry of the policy allows the target of the routine: the
// tool of the output and the page or its category by name, in NFC, as the
// loader keeps the names of a routine.
const allows = (
  entry: UnattendedEntry,
  tool: string,
  scope: { readonly category: string; readonly page: string },
): boolean => {
  if (!entry.tools.includes(tool)) return false;
  const name = entry.target.name.normalize('NFC');
  return (
    (entry.target.kind === 'wiki_page' && name === scope.page) ||
    (entry.target.kind === 'wiki_category' && name === scope.category)
  );
};

/**
 * Checks a loaded routine against the tools, the policy and the models,
 * and settles what its run needs.
 *
 * @param loaded - A routine the loader returned.
 * @param context - The facts of the tools, the policy and the aliases of
 *   the models.
 * @returns The prepared routine, deeply frozen, or the code of the first
 *   problem with the path of its field. It never throws for a routine.
 * @example
 * ```ts
 * const prepared = prepareRun(loaded, { tool, policy, models });
 * if (!prepared.ok) report(prepared.code, prepared.field);
 * ```
 */
export function prepareRun(
  loaded: LoadedRoutine,
  context: RunPrepareContext,
): RunPrepareResult {
  const { routine } = loaded;
  // The checks of the core come with the routine wiki-hygiene; until then
  // such a routine would fill its blocks with nothing.
  if (routine.generate === undefined) {
    return refuse('run_checks_pending', 'checks');
  }

  const inputs: PreparedInput[] = [];
  for (const [index, input] of routine.inputs.entries()) {
    const at = `inputs[${String(index)}]`;
    const facts = context.tool(input.tool);
    if (facts === undefined) return refuse('run_tool_unknown', `${at}.tool`);
    // Only a read tool that a routine may rely on and that may run without
    // a person; the pipeline holds the same for every read of a run.
    if (
      facts.capability !== 'read' ||
      !facts.routineStable ||
      facts.unattended !== 'policy'
    ) {
      return refuse('run_tool_unfit', `${at}.tool`);
    }
    const source = inputs.find(
      (prepared) => prepared.input.name === input.forEach,
    )?.facts;
    const problem = paramProblem(input, facts, at, source);
    if (problem !== undefined) return refuse(problem[0], problem[1]);
    inputs.push(Object.freeze({ input, facts }));
  }

  // One account per run: every entry of the routine names the same alias
  // (ADR 0033).
  const entries = context.policy.unattended.filter(
    (entry) => entry.routine === routine.id,
  );
  const settled = runCredentialOf(context.policy, routine.id);
  if (!settled.ok) return refuse('run_credential_mixed');
  const { credential } = settled;

  // A target in ChurchTools without an entry of the policy keeps the
  // routine from starting; a draft to a file needs none (ADR 0033). A
  // preview writes nothing, so it runs before the entry is there.
  const { output } = routine;
  const preview = context.preview === true;
  const target =
    output.target === 'wiki'
      ? entries.find((entry) => allows(entry, output.tool, output.scope))
      : undefined;
  if (output.target === 'wiki' && target === undefined && !preview) {
    return refuse('run_target_unlisted', 'output.scope');
  }

  const { generate } = routine;
  if (!context.models.has(generate.model)) {
    return refuse('run_model_unknown', 'generate.model');
  }

  return Object.freeze({
    __proto__: null,
    ok: true,
    run: Object.freeze({
      loaded,
      inputs: Object.freeze(inputs),
      redaction: modelRedactionOf(entries, generate.redaction),
      model: generate.model,
      entries: Object.freeze(entries),
      ...(target === undefined ? {} : { target }),
      ...(credential === undefined ? {} : { credential }),
      ...(preview ? { preview: true } : {}),
    }),
  });
}
