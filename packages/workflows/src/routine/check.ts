/**
 * The check of a routine and the routine with its defaults (ADR 0033).
 *
 * Where it stands in a run: when the routines are loaded, after the
 * reader of YAML and before the prompt and the template are read. It
 * checks the plain values against the schema of `routine.v1`, then
 * refuses what the schema cannot see: a schedule that cron reads in more
 * than one way, a routine with both a model and checks or with neither,
 * an input that names an input it cannot use, a range of numbers that is
 * empty, a key of another routine and a channel the core does not know.
 * A routine that contradicts itself would leave it to chance what a run
 * does, so the runner does not start it.
 *
 * Not checked here, because it needs the registry of the tools and the
 * policy: whether a tool is a read tool fit for routines, whether the
 * parameters fit the tool, and whether the policy allows the target.
 * That comes when a run is prepared.
 *
 * A problem is reported with its code and the path of the field, built
 * only from names of the schema, names the routine chose that passed
 * their pattern, and positions in lists, never with another value of the
 * file.
 *
 * @packageDocumentation
 */
import { checkSchedule } from '@ecclium/mcp-churchtools-core';

import {
  type Routine,
  type RoutineBlock,
  type RoutineCheck,
  type RoutineCheckName,
  type RoutineFile,
  routineFileSchema,
  type RoutineInput,
  routineLimits,
  type RoutineOutput,
  type RoutineParamValue,
  type RoutinePeriod,
} from './schema.js';
import { periodTag } from './template.js';

/** Why a value is no routine, frozen. */
export const routineCheckCodes = Object.freeze([
  'routine_version_unknown',
  'routine_invalid',
  'routine_schedule_invalid',
  'routine_schedule_days',
  'routine_generate_or_checks',
  'routine_inputs',
  'routine_reference',
  'routine_contradiction',
  'routine_channel_unknown',
] as const);

/** Why a value is no routine. */
export type RoutineCheckCode = (typeof routineCheckCodes)[number];

/** The checked routine, or why there is none. */
export type RoutineCheckResult =
  | { readonly ok: true; readonly routine: Routine }
  | {
      readonly ok: false;
      readonly code: RoutineCheckCode;
      /** The path of the field, such as `inputs[1].forEach`. */
      readonly field?: string;
    };

/**
 * The channels of a draft the free core brings: `file`, one file per
 * routine and period in a folder of the configuration. The channels of
 * Pro come with their plugin, without a change to `routine.v1`.
 */
export const draftChannels: readonly string[] = Object.freeze(['file']);

/** The channels of a notice after a run the free core brings. */
export const notifyChannels: readonly string[] = Object.freeze([
  'file',
  'stdout',
]);

/**
 * The fields of the block each check of the core fills, by the name of
 * the check. The block has the name of the check and as many entries as
 * its `maxItems`.
 */
export const checkBlockFields: Readonly<
  Record<RoutineCheckName, RoutineBlock['fields']>
> = Object.freeze({
  stalePages: Object.freeze({
    page: Object.freeze({ type: 'text', maxLength: routineLimits.name }),
    category: Object.freeze({ type: 'text', maxLength: routineLimits.name }),
    changed: Object.freeze({ type: 'date' }),
  }),
  brokenLinks: Object.freeze({
    page: Object.freeze({ type: 'text', maxLength: routineLimits.name }),
    link: Object.freeze({ type: 'text', maxLength: routineLimits.name }),
  }),
});

const refuse = (code: RoutineCheckCode, field?: string): RoutineCheckResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(field === undefined ? {} : { field }),
  });

// A name of the schema or a name the routine chose and its pattern took.
// Anything else ends the path, so that no other text of the file reaches
// a message.
const fieldName = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * Writes the path of an issue of zod as a message shows it. Only names
 * and positions in lists count; the path ends before anything else.
 *
 * @param path - The path of the issue.
 * @returns The path, such as `generate.output.blocks.mehrfach.maxItems`,
 *   or undefined for the whole file.
 * @example
 * ```ts
 * routineFieldOf(['inputs', 1, 'forEach']); // 'inputs[1].forEach'
 * ```
 */
export function routineFieldOf(
  path: readonly PropertyKey[],
): string | undefined {
  let field = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      field += `[${String(segment)}]`;
    } else if (typeof segment === 'string' && fieldName.test(segment)) {
      field += field === '' ? segment : `.${segment}`;
    } else {
      break;
    }
  }
  return field === '' ? undefined : field;
}

// An own data property of a plain object, never through a getter.
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

const isFieldRef = (value: RoutineParamValue): value is { field: string } =>
  typeof value === 'object';

// The first problem of the inputs, with the path of its field.
const inputProblem = (
  inputs: NonNullable<RoutineFile['inputs']>,
): readonly [RoutineCheckCode, string] | undefined => {
  const seen = new Map<string, boolean>();
  for (const [index, input] of inputs.entries()) {
    const at = `inputs[${String(index)}]`;
    if (seen.has(input.name)) return ['routine_contradiction', `${at}.name`];
    const refs = Object.entries(input.params ?? {}).filter(([, value]) =>
      isFieldRef(value),
    );
    if (input.forEach === undefined) {
      const [ref] = refs;
      if (ref !== undefined) {
        return ['routine_reference', `${at}.params.${ref[0]}`];
      }
    } else {
      // Only an earlier input without a loop of its own: the calls of an
      // input stay bounded by the entries of one other input.
      const source = seen.get(input.forEach);
      if (source !== false || refs.length === 0) {
        return ['routine_reference', `${at}.forEach`];
      }
    }
    seen.set(input.name, input.forEach !== undefined);
  }
  return undefined;
};

// The first problem of the blocks of the model, as the path of its
// field: an empty range of numbers, or the name `period`, which a template
// keeps for the period of the run.
const blockProblem = (
  blocks: Readonly<Record<string, RoutineBlock>>,
): string | undefined => {
  for (const [blockName, block] of Object.entries(blocks)) {
    const at = `generate.output.blocks.${blockName}`;
    if (blockName === periodTag) return at;
    for (const [fieldName, field] of Object.entries(block.fields)) {
      if (fieldName === periodTag) return `${at}.fields.${fieldName}`;
      if (field.type === 'integer' && field.min > field.max) {
        return `${at}.fields.${fieldName}.min`;
      }
    }
  }
  return undefined;
};

const freezeBlocks = (
  blocks: Readonly<Record<string, RoutineBlock>>,
): Readonly<Record<string, RoutineBlock>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(blocks).map(([name, block]) => [
        name,
        Object.freeze({
          maxItems: block.maxItems,
          fields: Object.freeze(
            Object.fromEntries(
              Object.entries(block.fields).map(([fieldName, field]) => [
                fieldName,
                Object.freeze({ ...field }),
              ]),
            ),
          ),
        }),
      ]),
    ),
  );

const freezeInput = (
  input: NonNullable<RoutineFile['inputs']>[number],
): RoutineInput =>
  Object.freeze({
    name: input.name,
    tool: input.tool,
    ...(input.forEach === undefined ? {} : { forEach: input.forEach }),
    params: Object.freeze(
      Object.fromEntries(
        Object.entries(input.params ?? {}).map(([key, value]) => [
          key,
          isFieldRef(value) ? Object.freeze({ field: value.field }) : value,
        ]),
      ),
    ),
    maxItems: input.maxItems,
  });

const periodOf = (key: string): RoutinePeriod =>
  key.endsWith('{isoWeek}')
    ? 'isoWeek'
    : key.endsWith('{month}')
      ? 'month'
      : 'date';

const freezeOutput = (output: RoutineFile['output']): RoutineOutput =>
  output.target === 'wiki'
    ? Object.freeze({
        target: 'wiki',
        tool: output.tool,
        scope: Object.freeze({
          category: output.scope.category.normalize('NFC'),
          page: output.scope.page.normalize('NFC'),
        }),
        idempotencyKey: output.idempotencyKey,
        period: periodOf(output.idempotencyKey),
      })
    : Object.freeze({
        target: 'draft',
        channel: output.channel,
        idempotencyKey: output.idempotencyKey,
        period: periodOf(output.idempotencyKey),
      });

/**
 * The blocks a run fills: those of the step with a model, or one block
 * per check of the core, with the name of the check and its fixed fields.
 *
 * @param routine - A checked routine.
 * @returns The blocks by name, frozen.
 * @example
 * ```ts
 * Object.keys(routineBlocks(routine)); // ['unbesetzt', 'mehrfach', 'hinweise']
 * ```
 */
export function routineBlocks(
  routine: Routine,
): Readonly<Record<string, RoutineBlock>> {
  if (routine.generate !== undefined) return routine.generate.blocks;
  return Object.freeze(
    Object.fromEntries(
      (routine.checks ?? []).map((check) => [
        check.check,
        Object.freeze({
          maxItems: check.maxItems,
          fields: checkBlockFields[check.check],
        }),
      ]),
    ),
  );
}

/**
 * Checks the plain values of a file of a routine and returns the routine
 * with its defaults, deeply frozen. Names of the wiki come in the normal
 * form NFC, so that they compare with the names of ChurchTools.
 *
 * @param value - The plain values the reader of YAML returned.
 * @returns The routine, or the code of the first problem with the path of
 *   its field. It never throws for a value.
 * @example
 * ```ts
 * const checked = checkRoutine(readValues);
 * if (!checked.ok) report(checked.code, checked.field);
 * ```
 */
export function checkRoutine(value: unknown): RoutineCheckResult {
  // Without its version, or with another, the rest of the file means
  // something else, so its fields are not checked against this schema.
  if (ownData(value, 'schema') !== 'routine.v1') {
    return refuse(
      'routine_version_unknown',
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? 'schema'
        : undefined,
    );
  }
  const parsed = routineFileSchema.safeParse(value);
  if (!parsed.success) {
    // A failed parse has at least one issue; the first one counts. A name
    // the routine chose that fails its pattern ends the path of its own
    // issue, so that the message names the map, not the name.
    const [field] = parsed.error.issues
      .slice(0, 1)
      .map((issue) =>
        routineFieldOf(
          issue.code === 'invalid_key' ? issue.path.slice(0, -1) : issue.path,
        ),
      );
    return refuse('routine_invalid', field);
  }
  const file = parsed.data;

  const schedule = checkSchedule(file.schedule);
  if (!schedule.ok) {
    return refuse(
      schedule.reason === 'days'
        ? 'routine_schedule_days'
        : 'routine_schedule_invalid',
      'schedule',
    );
  }

  // A run is filled either by a model or by fixed checks of the core,
  // never both, so that one routine has one source of its blocks.
  if ((file.generate === undefined) === (file.checks === undefined)) {
    return refuse(
      'routine_generate_or_checks',
      file.generate === undefined ? undefined : 'checks',
    );
  }
  // A model needs data; the checks of the core read for themselves.
  if ((file.generate === undefined) !== (file.inputs === undefined)) {
    return refuse('routine_inputs', 'inputs');
  }

  const inputs = file.inputs ?? [];
  const input = inputProblem(inputs);
  if (input !== undefined) return refuse(input[0], input[1]);

  if (file.generate !== undefined) {
    const block = blockProblem(file.generate.output.blocks);
    if (block !== undefined) return refuse('routine_contradiction', block);
  }

  const checks = file.checks ?? [];
  for (const [index, check] of checks.entries()) {
    if (checks.findIndex((other) => other.check === check.check) !== index) {
      return refuse('routine_contradiction', `checks[${String(index)}].check`);
    }
  }

  // The key names the routine, so that the marking of one routine never
  // counts as the section of another.
  if (!file.output.idempotencyKey.startsWith(`${file.id}:`)) {
    return refuse('routine_contradiction', 'output.idempotencyKey');
  }
  if (file.output.target === 'draft') {
    if (!draftChannels.includes(file.output.channel)) {
      return refuse('routine_channel_unknown', 'output.channel');
    }
  }
  const notify = file.notify ?? [];
  for (const [index, entry] of notify.entries()) {
    const at = `notify[${String(index)}].channel`;
    if (!notifyChannels.includes(entry.channel)) {
      return refuse('routine_channel_unknown', at);
    }
    if (
      notify.findIndex((other) => other.channel === entry.channel) !== index
    ) {
      return refuse('routine_contradiction', at);
    }
  }

  const generate =
    file.generate === undefined
      ? undefined
      : Object.freeze({
          prompt: file.generate.prompt,
          model: file.generate.model,
          ...(file.generate.redaction === undefined
            ? {}
            : { redaction: file.generate.redaction }),
          maxOutputTokens:
            file.generate.maxOutputTokens ?? routineLimits.defaultOutputTokens,
          blocks: freezeBlocks(file.generate.output.blocks),
        });
  const routine: Routine = Object.freeze({
    schema: 'routine.v1',
    id: file.id,
    schedule: file.schedule,
    inputs: Object.freeze(inputs.map(freezeInput)),
    ...(generate === undefined ? {} : { generate }),
    ...(file.checks === undefined
      ? {}
      : {
          checks: Object.freeze(
            checks.map((check): RoutineCheck => Object.freeze({ ...check })),
          ),
        }),
    template: file.template,
    output: freezeOutput(file.output),
    notify: Object.freeze(
      notify.map((entry) => Object.freeze({ channel: entry.channel })),
    ),
  });
  return Object.freeze({ __proto__: null, ok: true, routine });
}
