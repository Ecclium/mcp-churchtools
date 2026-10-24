/**
 * The contract of a tool: name, metadata, description, schemas and what it
 * does (ADR 0024).
 *
 * @packageDocumentation
 */

import type { ZodType, z } from 'zod';

import type { TenantContext } from './context.js';
import type { ReadApi } from './read-api.js';

/**
 * Name of a tool. Every name starts with `ct_`. Tools of a domain follow the
 * scheme `ct_<domain>_<action>`; tools of the base, such as `ct_whoami`, have
 * no domain part.
 */
export type ToolName = `ct_${string}`;

/**
 * The area of ChurchTools a tool belongs to. The operator turns areas on
 * in groups, the toolsets, and the server offers only the tools of those
 * (ADR 0062). `base` is always on and reserved for the tools of the core,
 * such as `ct_whoami`: the registry refuses a tool of another plugin there.
 */
export type ToolDomain =
  | 'base'
  | 'persons'
  | 'groups'
  | 'events'
  | 'services'
  | 'calendars'
  | 'appointments'
  | 'resources'
  | 'bookings'
  | 'wiki'
  | 'songs'
  | 'docs'
  | 'api';

/**
 * A right of ChurchTools by module and name, as `GET /api/permissions/global`
 * lists it, such as `churchdb` and `view alldata`.
 */
export interface RightRef {
  /** Module of the right, such as `churchdb`. */
  readonly module: string;
  /** Name of the right within the module. */
  readonly right: string;
}

/**
 * How sensitive the data of a tool is. `special` covers persons and group
 * memberships, which reveal religious affiliation.
 */
export type Sensitivity = 'none' | 'personal' | 'special';

/** Whether a tool may run without a person: never, or as a policy allows. */
export type UnattendedRule = 'never' | 'policy';

/** Whether a write can be undone, and how. */
export type Reversible = 'yes' | 'no' | 'snapshot';

/** What keeps a write from taking effect twice. */
export type ReplayGuard = 'baseVersion' | 'marker' | 'nonce';

/** Whether a tool is part of the free core or of the paid extension. */
export type Tier = 'free' | 'pro';

/** Metadata every tool carries, read or write. */
export interface ToolMetaCommon {
  /** The area of ChurchTools. */
  readonly domain: ToolDomain;
  /**
   * Rights the account of the server needs, each proven per operation. A
   * refused call names them, never a message of ChurchTools.
   */
  readonly requiredRights: readonly RightRef[];
  /** Free core or paid extension. */
  readonly tier: Tier;
  /**
   * Whether routines rely on name and input schema. A breaking change to a
   * tool marked so is a new major version.
   */
  readonly routineStable: boolean;
}

/**
 * Sensitivity and the rule for running without a person. A tool of the
 * sensitivity `special` never runs unattended, whatever a policy says.
 */
export type Exposure =
  | { readonly sensitivity: 'special'; readonly unattended: 'never' }
  | {
      readonly sensitivity: 'none' | 'personal';
      readonly unattended: UnattendedRule;
    };

/** Metadata of a tool that only reads. */
export type ReadToolMeta = ToolMetaCommon &
  Exposure & {
    readonly capability: 'read';
    /** Not for reading tools. */
    readonly reversible?: never;
    /** Not for reading tools. */
    readonly replayGuard?: never;
  };

/**
 * Metadata of a tool that writes. It must say whether the write can be
 * undone and what keeps it from taking effect twice.
 */
export type WriteToolMeta = ToolMetaCommon &
  Exposure & {
    readonly capability: 'write';
    readonly reversible: Reversible;
    readonly replayGuard: ReplayGuard;
  };

/**
 * The metadata of a tool. It is not decoration: it decides whether the tool
 * is registered, how its output is redacted and audited, and whether it may
 * run without a person. The types forbid the combinations the registry of
 * the core refuses at run time as well.
 */
export type ToolMeta = ReadToolMeta | WriteToolMeta;

/**
 * The description the model reads, in sections every tool must fill. The
 * required rights come from the metadata, not from this text. The text is
 * static and holds no content of a tenant, or the list of tools would itself
 * carry injected instructions.
 */
export interface ToolDescription {
  /** What the tool does. */
  readonly purpose: string;
  /** When to use it. */
  readonly useWhen: string;
  /** When not to use it, and what to use instead. */
  readonly avoidWhen: string;
  /** What it cannot do, such as limits on the number of results. */
  readonly limits: string;
}

/** What a tool receives for one call. */
export interface ToolCall<Input> {
  /** The tenant context of this call, read-only. */
  readonly ctx: TenantContext;
  /** The input, already checked against the input schema of the tool. */
  readonly input: Input;
  /** Read access to ChurchTools, valid only during this call. */
  readonly read: ReadApi;
}

/**
 * A tool as the core runs it. The tool only returns data: the pipeline of
 * the core checks input and output, redacts, wraps free text and writes the
 * audit (ADR 0024). The output schema declares every field of the result; a
 * schema that lets other fields through, such as a loose object, defeats
 * that check.
 *
 * Write tools with {@link defineTool}, which checks `execute` against the
 * schemas. This type is what the core keeps: `execute` is a method here, so
 * that a tool of any input and result fits `ToolDefinition<unknown, unknown>`.
 */
export interface ToolDefinition<Input = unknown, Result = unknown> {
  /** Name of the tool. */
  readonly name: ToolName;
  /** Metadata of the tool. */
  readonly meta: ToolMeta;
  /** Description for the model. */
  readonly description: ToolDescription;
  /** Schema of the input; `execute` receives what it parses to. */
  readonly input: ZodType<Input>;
  /**
   * Schema of the result. The pipeline parses what `execute` returns with it,
   * so `execute` returns what the schema takes, before any transform. Each
   * leaf should carry a data class (see `classify`), or it is not redacted.
   */
  readonly output: ZodType<unknown, Result>;
  /**
   * Runs the tool for one call.
   *
   * @param call - Context, checked input and read access of the call.
   * @returns The data of the result, not yet checked or redacted.
   */
  execute(call: ToolCall<Input>): Promise<Result>;
}

/**
 * Schema of the input or the result of a tool: an object, because MCP takes
 * only objects as input and as structured result.
 */
export type ObjectSchema = ZodType<
  Record<string, unknown>,
  Record<string, unknown>
>;

/** A tool as its author writes it, for {@link defineTool}. */
export interface ToolSpec<
  InputSchema extends ObjectSchema,
  OutputSchema extends ObjectSchema,
> {
  /** Name of the tool. */
  readonly name: ToolName;
  /** Metadata of the tool. */
  readonly meta: ToolMeta;
  /** Description for the model. */
  readonly description: ToolDescription;
  /** Schema of the input. */
  readonly input: InputSchema;
  /** Schema of the result. */
  readonly output: OutputSchema;
  // A property, not a method: TypeScript then checks the parameter strictly,
  // so a handler that expects more input than the schema gives does not
  // compile. The types come from the schemas alone, never from execute.
  /** Runs the tool for one call; returns what the output schema takes. */
  readonly execute: (
    call: ToolCall<z.output<InputSchema>>,
  ) => Promise<z.input<OutputSchema>>;
}

/**
 * Returns the given tool unchanged. It exists for the types: input and
 * result of `execute` follow from the two schemas alone, so `execute` can
 * neither expect more input than the input schema gives nor return less
 * than the output schema takes.
 *
 * @param tool - The tool.
 * @returns The same tool, as the core keeps it.
 * @example
 * ```ts
 * const whoami = defineTool({
 *   name: 'ct_whoami',
 *   meta: { capability: 'read', domain: 'base', requiredRights: [],
 *     tier: 'free', sensitivity: 'personal', unattended: 'never',
 *     routineStable: false },
 *   description: { purpose: '…', useWhen: '…', avoidWhen: '…', limits: '…' },
 *   input: z.object({}),
 *   output: z.object({ id: classify(z.number(), 'personId') }),
 *   execute: async ({ read }) => ({ id: (await read.whoami()).id }),
 * });
 * ```
 */
export function defineTool<
  InputSchema extends ObjectSchema,
  OutputSchema extends ObjectSchema,
>(
  tool: ToolSpec<InputSchema, OutputSchema>,
): ToolDefinition<z.output<InputSchema>, z.input<OutputSchema>> {
  // The same object, returned with the types of its schemas. TypeScript
  // cannot prove for every schema type that it parses to its own output
  // type, so the tool is widened first and then narrowed to those types.
  const kept: ToolDefinition = tool;
  return kept as ToolDefinition<z.output<InputSchema>, z.input<OutputSchema>>;
}
