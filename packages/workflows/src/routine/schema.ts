/**
 * The schema of a routine, `routine.v1` (ADR 0033).
 *
 * Where it stands in a run: at the very start, when the routines are
 * loaded, before anything is due. The loader reads a file of YAML, and
 * this schema checks its plain values strictly: an unknown field, a wrong
 * type or a value out of its range fails the routine, and the runner does
 * not start it. What passes describes the whole run: when it is due, what
 * it reads, how the model or the fixed checks of the core fill which
 * blocks, which template the blocks go into and where the result goes.
 *
 * Why every field has a limit: a run reads foreign text and may follow an
 * instruction in it. What a routine allows is decided before the run, so
 * a block has a number of entries, a text a length and a number a range,
 * and an injection can change what a field says but not how many fields
 * there are or where they go.
 *
 * The schema of zod stays in this package. Others get plain data, the
 * JSON Schema made from it and the checked routine.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

/** The limits of a routine, frozen. */
export const routineLimits = Object.freeze({
  /** The longest ID of a routine, as for a routine of the policy. */
  id: 63,
  /** The most inputs of a routine. */
  inputs: 10,
  /** The most entries one input passes on, over all its calls. */
  inputItems: 200,
  /** The most parameters of an input. */
  params: 10,
  /** The longest text of a parameter. */
  paramLength: 200,
  /** The most blocks of a routine. */
  blocks: 10,
  /** The most entries of a block. */
  blockItems: 100,
  /** The most fields of a block. */
  fields: 8,
  /** The longest text of a field. */
  textLength: 1000,
  /** The largest number of a field, and the smallest as its negative. */
  integer: 1_000_000_000,
  /** The fewest tokens a routine may give the answer of the model. */
  minOutputTokens: 100,
  /** The most tokens a routine may give the answer of the model. */
  maxOutputTokens: 8000,
  /** The tokens of the answer without a value in the routine. */
  defaultOutputTokens: 2000,
  /** The fewest days after which a page counts as not changed for long. */
  minStaleDays: 30,
  /** The most days after which a page counts as not changed for long. */
  maxStaleDays: 3650,
  /** The most notices after a run. */
  notify: 2,
  /** The longest name of a category or a page of the wiki. */
  name: 255,
  /** The longest name of an input, a block or a field. */
  ownName: 32,
  /** The longest path of a prompt or a template. */
  path: 130,
  /** The longest schedule. */
  schedule: 100,
} as const);

/** The levels of redaction a routine may wish for its call of the model. */
export const routineRedactionLevels = Object.freeze([
  'strict',
  'standard',
] as const);

/** The checks of the core a routine without a model may choose. */
export const routineCheckNames = Object.freeze([
  'stalePages',
  'brokenLinks',
] as const);

/** A check of the core a routine without a model may choose. */
export type RoutineCheckName = (typeof routineCheckNames)[number];

/** The periods a key of a routine may name, as its placeholder. */
export const routinePeriods = Object.freeze([
  'isoWeek',
  'date',
  'month',
] as const);

/** A period a key of a routine may name. */
export type RoutinePeriod = (typeof routinePeriods)[number];

// The ID of a routine, as `routine` of an entry of the policy: lower case
// letters, digits and dashes. The same pattern names a model and a
// channel, which are no free text either.
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A name the routine gives an input, a block or a field. It stands in a
// template as {{name}}, so it is plain.
const ownNamePattern = /^[a-z][a-z0-9_]{0,31}$/;
// A parameter of a tool, as the schemas of the tools name them.
const paramPattern = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
// A tool of the core or a plugin, as the registry names it.
const toolPattern = /^ct_[a-z0-9_]{1,60}$/;
// A prompt or a template: a file of Markdown in the folder of the
// routines or in one folder below it. Each part starts with a letter or
// digit, so there is no `..`, no hidden file and no absolute path.
const filePattern =
  /^(?:[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,59}\.md$/;
// The key of a run: the ID of the routine, a colon and one period.
const keyPattern = /^[a-z0-9][a-z0-9-]{0,62}:\{(?:isoWeek|date|month)\}$/;
// Five fields of a schedule, one space apart. What a field may hold, the
// check of the schedule decides; the limit of the whole schedule bounds a
// field, so that a long list of minutes is refused there with its reason.
const schedulePattern = /^[0-9A-Za-z*,/-]+(?: [0-9A-Za-z*,/-]+){4}$/;
// A text without control characters, such as a name in ChurchTools.
const plainPattern = /^\P{Cc}*$/u;

const id = z.string().max(routineLimits.id).regex(idPattern);
const ownName = z.string().max(routineLimits.ownName).regex(ownNamePattern);
const file = z.string().max(routineLimits.path).regex(filePattern);
const wikiName = z
  .string()
  .min(1)
  .max(routineLimits.name)
  .regex(/^\P{Cc}+$/u);
const integer = z.int().min(-routineLimits.integer).max(routineLimits.integer);

// A map with names the routine chooses, with a size the schema of zod
// checks and JSON Schema states, from the same numbers.
const mapOf = <V extends z.ZodType>(
  key: z.ZodString,
  value: V,
  min: number,
  max: number,
) =>
  z
    .record(key, value)
    .refine((map) => {
      const size = Object.keys(map).length;
      return size >= min && size <= max;
    })
    .meta({ minProperties: min, maxProperties: max });

const field = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    maxLength: z.int().min(1).max(routineLimits.textLength),
  }),
  z.strictObject({ type: z.literal('integer'), min: integer, max: integer }),
  z.strictObject({ type: z.literal('date') }),
  z.strictObject({ type: z.literal('person') }),
]);

const blockItems = z.int().min(1).max(routineLimits.blockItems);

const block = z.strictObject({
  maxItems: blockItems,
  fields: mapOf(ownName, field, 1, routineLimits.fields),
});

// A value of a parameter: a text, such as a relative day like "+14d", a
// number, a switch, or the field of the entry of `forEach`.
const paramValue = z.union([
  z.string().max(routineLimits.paramLength).regex(plainPattern),
  integer,
  z.boolean(),
  z.strictObject({ field: z.string().max(32).regex(paramPattern) }),
]);

const input = z.strictObject({
  name: ownName,
  tool: z.string().max(63).regex(toolPattern),
  forEach: ownName.optional(),
  params: mapOf(
    z.string().max(32).regex(paramPattern),
    paramValue,
    0,
    routineLimits.params,
  ).optional(),
  maxItems: z.int().min(1).max(routineLimits.inputItems),
});

const generate = z.strictObject({
  prompt: file,
  model: id,
  redaction: z.enum(routineRedactionLevels).optional(),
  maxOutputTokens: z
    .int()
    .min(routineLimits.minOutputTokens)
    .max(routineLimits.maxOutputTokens)
    .optional(),
  output: z.strictObject({
    blocks: mapOf(ownName, block, 1, routineLimits.blocks),
  }),
});

const check = z.discriminatedUnion('check', [
  z.strictObject({
    check: z.literal('stalePages'),
    olderThanDays: z
      .int()
      .min(routineLimits.minStaleDays)
      .max(routineLimits.maxStaleDays),
    maxItems: blockItems,
  }),
  z.strictObject({
    check: z.literal('brokenLinks'),
    maxItems: blockItems,
  }),
]);

const idempotencyKey = z.string().max(80).regex(keyPattern);

const output = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('wiki'),
    tool: z.literal('ct_wiki_page_append_section'),
    scope: z.strictObject({ category: wikiName, page: wikiName }),
    idempotencyKey,
  }),
  z.strictObject({
    target: z.literal('draft'),
    channel: id,
    idempotencyKey,
  }),
]);

/**
 * A routine as its file states it. Strict at every level. What spans
 * several fields, such as `generate` or `checks` but not both, the check
 * of the routine decides after this schema.
 */
export const routineFileSchema = z.strictObject({
  schema: z.literal('routine.v1'),
  id,
  schedule: z.string().max(routineLimits.schedule).regex(schedulePattern),
  inputs: z.array(input).min(1).max(routineLimits.inputs).optional(),
  generate: generate.optional(),
  checks: z.array(check).min(1).max(routineCheckNames.length).optional(),
  template: file,
  output,
  notify: z
    .array(z.strictObject({ channel: id }))
    .min(1)
    .max(routineLimits.notify)
    .optional(),
});

/** A routine as the schema returns it. */
export type RoutineFile = z.output<typeof routineFileSchema>;

/** A field of a block. */
export type RoutineField = z.output<typeof field>;

/** A block: how many entries and which fields each has. */
export interface RoutineBlock {
  readonly maxItems: number;
  readonly fields: Readonly<Record<string, Readonly<RoutineField>>>;
}

/** A value of a parameter of an input. */
export type RoutineParamValue =
  string | number | boolean | { readonly field: string };

/** An input: one read tool, called once or once per entry of another. */
export interface RoutineInput {
  readonly name: string;
  readonly tool: string;
  readonly forEach?: string;
  readonly params: Readonly<Record<string, RoutineParamValue>>;
  readonly maxItems: number;
}

/** The step with a model. */
export interface RoutineGenerate {
  readonly prompt: string;
  readonly model: string;
  /** Only a wish: the policy decides, and a wish only makes it stricter. */
  readonly redaction?: (typeof routineRedactionLevels)[number];
  readonly maxOutputTokens: number;
  readonly blocks: Readonly<Record<string, RoutineBlock>>;
}

/** A check of the core, with its settings. */
export type RoutineCheck = Readonly<z.output<typeof check>>;

/** Where the result of a run goes, with the period its key names. */
export type RoutineOutput =
  | {
      readonly target: 'wiki';
      readonly tool: 'ct_wiki_page_append_section';
      readonly scope: { readonly category: string; readonly page: string };
      readonly idempotencyKey: string;
      readonly period: RoutinePeriod;
    }
  | {
      readonly target: 'draft';
      readonly channel: string;
      readonly idempotencyKey: string;
      readonly period: RoutinePeriod;
    };

/**
 * A checked routine with every default in place, deeply frozen: what the
 * runner works with. Exactly one of `generate` and `checks` is there, and
 * `inputs` is empty without `generate`.
 */
export interface Routine {
  readonly schema: 'routine.v1';
  readonly id: string;
  readonly schedule: string;
  readonly inputs: readonly RoutineInput[];
  readonly generate?: RoutineGenerate;
  readonly checks?: readonly RoutineCheck[];
  readonly template: string;
  readonly output: RoutineOutput;
  readonly notify: readonly { readonly channel: string }[];
}

/**
 * The JSON Schema of a file of a routine, made with `z.toJSONSchema` from
 * the schema of zod on each call. Editors can check a file and complete it
 * with it. It describes what the operator writes; what spans several
 * fields, such as `generate` or `checks` but not both, it does not
 * express.
 *
 * @returns The schema in JSON Schema 2020-12, a new object each time.
 * @example
 * ```ts
 * routineJsonSchema().type; // 'object'
 * ```
 */
export function routineJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(routineFileSchema, {
    target: 'draft-2020-12',
    io: 'input',
  });
}
