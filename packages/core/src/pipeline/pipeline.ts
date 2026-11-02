/**
 * The one pipeline every call of a tool runs through (ADR 0024). Its
 * stages are fixed in this code; no plugin adds or removes one:
 *
 * 1. find the tool in the catalog,
 * 2. make the context of the call, with a signal of its own, or end with
 *    `auth` when the call has no tenant or none the pipeline can read,
 * 3. `gate`,
 * 4. `validateInput`, and for a tool with sensitivity special, or one the
 *    catalog treats as such because it names persons, the count against
 *    the daily read budget,
 * 5. `execute` with read access that is revoked afterwards,
 * 6. `validateOutput`, which drops every field the schema does not declare,
 * 7. `redact` and 8. `markUntrusted` with a boundary drawn for the call,
 * 9. the limit on the size of the result as the client receives it, and
 *    the mark of a redacted result, the only kind the mount sends (ADR
 *    0026),
 * 10. `audit`, in `finally`, also when a stage fails, with the IDs the
 *     call asks for and the IDs of the persons and groups its result
 *     names, derived from the schemas of the tool and the checked request
 *     of the escape hatch, never from its code (ADR 0028).
 *
 * In the level `strict`, a tool whose input or output holds an ID of a
 * person gets the pseudonyms of its principal right after the context:
 * every pseudonym in the input turns into its ID before `validateInput`,
 * and a raw ID ends the call with `validation`; `redact` turns every ID in
 * the result into its pseudonym. The code of the tool sees IDs only, the
 * audit records IDs only, and the keys are erased in `finally` (ADR 0069).
 *
 * Tenant and actor are copied once, before the first stage, through own
 * data properties only. The context and the audit use that copy, so no
 * getter and no trap of the resolver's answer can cost the audit line.
 *
 * The message of a failed call is masked like a result before it leaves.
 *
 * `serialize`, the only stage that knows MCP, lives in the mount.
 *
 * @packageDocumentation
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  type AuditOutcome,
  type Clock,
  type ConfirmationPath,
  EccliumError,
  type ErrorCode,
  type FeatureKey,
  type KeyProvider,
  type Mode,
  type PlanOutcome,
  type QuotaStore,
  type RedactionLevel,
  type TenantAssignment,
  type TenantContext,
  type ToolCall,
  type WritePort,
  type WriteState,
  type WriteToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';

import {
  type AuditSink,
  auditPlaceholders,
  createObjectRefCollector,
  type ObjectDomain,
  type ObjectRefCollector,
  type ObjectRefList,
} from '../audit/index.js';
import { createChurchToolsClient } from '../churchtools/index.js';
import {
  describeError,
  type ErrorDescription,
  fixedSentences,
} from '../errors/index.js';
import type { HttpTransport } from '../http/index.js';
import type { LineWriter, LogLevel } from '../logger/index.js';
import {
  chooseBoundary,
  isStrictLevel,
  maskErrorDescription,
  type RandomBytes,
} from '../redaction/index.js';
import {
  type CatalogEntry,
  collectInputRefs,
  type ToolCatalog,
} from '../registry/index.js';
import { defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { isoDateOf, quotaTimeoutMs } from '../quota/budget.js';
import { openPseudonyms, type Pseudonyms } from '../redaction/pseudonym.js';
import { type Redacted, sealRedacted } from '../redaction/redacted.js';
import { createTenantContext } from '../tenant/context.js';
import {
  confirmationSentence,
  confirmWrite,
  createWriteGuard,
  type WriteGuard,
  type WriteTarget,
} from '../write/index.js';
import { createReadAccess, type ReadAccess } from './read-api.js';
import {
  collectOutputRefs,
  fitsInput,
  outputIdsFit,
  markUntrusted,
  maxResultBytes,
  redact,
  resultBytes,
  type RevealedInput,
  revealInput,
} from './stages.js';

/** What the mount knows about one call, besides name and input. */
export interface ToolRequest {
  /**
   * Tenant and actor, from the resolver of the checked identity, or
   * `undefined` when the resolver assigns no tenant. A call without a
   * tenant ends with `auth` before any code of the tool runs, and is
   * audited all the same. The pipeline reads it once, through own data
   * properties only, and runs no getter and no trap of a proxy; an
   * assignment it cannot read that way counts as none.
   */
  readonly assignment: TenantAssignment | undefined;
  /** How the call runs, set by the composition root only. */
  readonly mode: Mode;
  /** The level of redaction. */
  readonly redaction: RedactionLevel;
  /** Whether the server only reads. */
  readonly readOnly: boolean;
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** The signal of the request, aborted when the client cancels it. */
  readonly signal: AbortSignal;
}

/**
 * What a call returns, before the mount turns it into MCP. The data of a
 * success carry the mark of a redacted result, which only the pipeline
 * gives and the mount checks at run time as well (ADR 0026).
 */
export type ToolOutcome =
  | { readonly ok: true; readonly data: Redacted }
  | { readonly ok: false; readonly error: ErrorDescription };

/** The pipeline of one ChurchTools instance. */
export interface ToolPipeline {
  /**
   * Runs one call of a tool through every stage.
   *
   * @param name - The name the client asked for.
   * @param input - The input as the client sent it.
   * @param request - What the mount knows about the call.
   * @returns The outcome. It never rejects.
   */
  call(
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<ToolOutcome>;
}

/** What the composition root builds the pipeline from. */
export interface ToolPipelineOptions {
  /** The frozen catalog of tools. */
  readonly catalog: ToolCatalog;
  /** The audit sink, built with `catalog.has` as its `isKnownTool`. */
  readonly audit: AuditSink;
  /** The transport of the instance, built by the composition root. */
  readonly transport: HttpTransport;
  /** The canonical origin of the instance, the same as the transport's. */
  readonly origin: string;
  /** Requests per minute to ChurchTools, from the configuration. */
  readonly requestsPerMinute: number;
  /** A frozen clock whose own method is frozen as well. */
  readonly clock: Clock;
  /** Where the log lines of each call go. */
  readonly logging: {
    readonly writer: LineWriter;
    readonly minLevel: LogLevel;
  };
  /**
   * The source of random bytes for the boundary of the data envelope,
   * `randomBytes` of `node:crypto` unless a test fixes the boundary.
   */
  readonly random?: RandomBytes;
  /**
   * The store of the daily read budget (ADR 0063). Without it, a tool with
   * sensitivity special, or one the catalog treats as such, does not run.
   */
  readonly quota?: QuotaStore;
  /**
   * The provider of the keys for pseudonyms, built by the composition root
   * from the key files (ADR 0069). Without it, a call in the level
   * `strict` of a tool with an ID of a person ends with `internal`.
   */
  readonly keys?: KeyProvider;
  /**
   * The folder of the kill switches of writing, from the configuration
   * (ADR 0029). Without it, every write tool is refused, because no switch
   * can be checked.
   */
  readonly killSwitchDir?: string;
  /**
   * The checked policy from the configuration (ADR 0032), for now for the
   * daily read budget. Without it the default policy applies, with a
   * budget of 200.
   */
  readonly policy?: Policy;
}

// The longest duration the audit accepts.
const maxDurationMs = 86_400_000;

const internalOutcome: ToolOutcome = Object.freeze({
  __proto__: null,
  ok: false,
  error: Object.freeze({
    __proto__: null,
    code: 'internal',
    message: fixedSentences.internal,
  }),
});

// A tool with sensitivity special, and one the catalog treats as such
// because it names persons, runs only with an audit file that can take its
// line, and its result goes out only once the line is in the file
// (ADR 0028, ADR 0064). Two fixed sentences, so that the model can tell a call
// that never ran from one whose result was held back.
const auditNotReady =
  'The audit file of the server cannot record this call now, so the tool did not run. Ask the operator to check the audit file.';
const auditWithheld =
  'The call could not be recorded in the audit file, so its result is held back. Ask the operator to check the audit file.';

const withheldOutcome: ToolOutcome = Object.freeze({
  __proto__: null,
  ok: false,
  error: Object.freeze({
    __proto__: null,
    code: 'policy_denied',
    message: auditWithheld,
  }),
});

// A call above the daily read budget of the policy, and one the store could
// not count (ADR 0032, ADR 0063). A budget of 0 lets no such tool run.
const budgetExhausted = (budget: number): string =>
  budget === 0
    ? 'The daily budget of calls of tools with special personal data is 0 on this server, so they do not run. Ask the operator.'
    : `The daily budget of ${String(budget)} calls of tools with special personal data is used up. It resets at 00:00 UTC.`;
const budgetUnavailable =
  'The server cannot count this call against the daily read budget now, so the tool did not run. Ask the operator to check the folder of state.';

const tooLarge =
  'The result is larger than 64 KiB. Narrow the request, for example with a more specific search.';

// A raw ID, a changed pseudonym or one of another principal at a field of
// a person in the level strict (ADR 0069).
const pseudonymExpected =
  'IDs of persons on this server are pseudonyms that start with p1_. Pass them on as a tool returned them.';

// The getter of AbortSignal itself: an own property `aborted` of a signal
// could hide it (ADR 0055).
const abortedGetter = Reflect.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
// The methods of EventTarget itself, for the same reason.
const addListener: unknown = Reflect.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'addEventListener',
)?.value;
const removeListener: unknown = Reflect.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'removeEventListener',
)?.value;

// A fixed reason, so no text of a client travels with an abort.
const abortReason = 'ecclium_call_aborted';

const isAborted = (signal: AbortSignal): boolean =>
  Reflect.apply(abortedGetter as () => boolean, signal, []);

// An object whose own properties can be read without running its code.
// isProxy runs no trap, also not for a revoked proxy.
const isPlainTarget = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !isProxy(value);

// An own data property, never inherited and never through a getter. An
// accessor reads as a missing key.
const ownData = (target: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(target, key);
  return property !== undefined && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
};

// Tenant and actor of the resolver's answer, copied into a frozen record
// (ADR 0024). An answer that is a proxy or holds one as its actor, or whose
// tenant, actor, kind or id is missing or an accessor, cannot be read
// without running its code and counts as no assignment. A value that can be
// read is copied as it is: the context refuses one that is not valid.
const copyAssignment = (value: unknown): TenantAssignment | undefined => {
  if (!isPlainTarget(value)) return undefined;
  const tenantId = ownData(value, 'tenantId');
  const actor = ownData(value, 'actor');
  if (tenantId === undefined || !isPlainTarget(actor)) return undefined;
  const kind = ownData(actor, 'kind');
  const id = ownData(actor, 'id');
  if (kind === undefined || id === undefined) return undefined;
  return Object.freeze({
    __proto__: null,
    tenantId,
    actor: Object.freeze({ __proto__: null, kind, id }),
  }) as unknown as TenantAssignment;
};

const failed = (
  code: ErrorCode,
  message?: string,
): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => ({
  outcome: Object.freeze({
    __proto__: null,
    ok: false,
    error: describeError(new EccliumError(code, message)),
  }),
  audit:
    code === 'policy_denied' || code === 'license_required'
      ? 'denied'
      : 'error',
});

/** The state of one call, for its `finally`. */
interface Run {
  /** The ID of the call, bound to its log lines and given to the audit. */
  eventId?: string;
  /** The copy of tenant and actor, the only one stages and audit read. */
  assignment?: TenantAssignment;
  entry?: CatalogEntry;
  redaction?: RedactionLevel;
  ctx?: TenantContext;
  access?: ReadAccess;
  detach?: () => void;
  /**
   * The IDs of the call, made once its input fits the schema: those of the
   * input first, then those a read of the escape hatch asks for.
   */
  refs?: ObjectRefCollector;
  /** The result as the output schema parsed it, before `redact`. */
  output?: Readonly<Record<string, unknown>>;
  /**
   * The pseudonyms of the call in the level `strict`, for a tool with an
   * ID of a person, erased in `finally` (ADR 0069).
   */
  pseudonyms?: Pseudonyms;
  /** The input with the IDs its pseudonyms stand for, or the refusal. */
  revealed?: RevealedInput;
  /** What a call of a write tool leaves for its audit line (ADR 0029). */
  write?: WriteRecord;
}

/** The state of a write at the end of its call, for the audit. */
interface WriteRecord {
  readonly writeState: WriteState;
  readonly confirmation?: ConfirmationPath;
  /** Whether a write may have reached ChurchTools. */
  readonly sent: boolean;
}

/** What a write tool used during its call, kept by the pipeline. */
interface WriteAccess {
  /** The port the tool gets in its call. */
  readonly port: WritePort;
  /** Ends the port: a later plan is refused. */
  readonly revoke: () => void;
  /** The outcome of the one plan of the call, if the tool planned. */
  readonly outcome: () => PlanOutcome | undefined;
  /** The target of that plan. */
  readonly target: () => WriteTarget | undefined;
  /** The refusal of the plan, if the guard refused it. */
  readonly refusal: () => EccliumError | undefined;
}

// Codes of a write that count as refused in the audit, not as an error
// (ADR 0029): the policy, a missing licence, a missing confirmation and a
// missing right.
const writeDenials: readonly ErrorCode[] = Object.freeze([
  'policy_denied',
  'license_required',
  'confirmation_required',
  'permission',
]);

// The state of a write that ended with an error, by its code.
const writeStateOf = (code: ErrorCode): WriteState =>
  writeDenials.includes(code)
    ? 'denied'
    : code === 'conflict'
      ? 'conflict'
      : 'failed';

// The state of a write for the audit line of its call: the one the write
// left, or for a write tool that ended before its write, refused or failed
// as its outcome says, so that whoever counts writes sees every call.
const writeStateOfCall = (
  run: Run,
  outcome: AuditOutcome,
  ok: boolean,
): WriteState | undefined => {
  if (run.write !== undefined) return run.write.writeState;
  if (ok || run.entry?.meta.capability !== 'write') return undefined;
  return outcome === 'denied' ? 'denied' : 'failed';
};

// The result of a write as the model gets it: state, target and version,
// built by the core (ADR 0029).
const writeResult = (
  state: 'verified' | 'skipped',
  target: WriteTarget,
  version?: number,
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    state,
    target: Object.freeze({ kind: target.kind, key: target.key }),
    ...(version === undefined ? {} : { version }),
  });

// The IDs of a target for the audit: a category, and a page by its GUID.
const addTarget = (refs: ObjectRefCollector, target: WriteTarget): void => {
  const [first, second] = target.key.split('/');
  if (target.kind === 'wiki_category') refs.add('wiki_category', first);
  if (target.kind === 'wiki_page') {
    refs.add('wiki_category', first);
    refs.add('wiki_page', second);
  }
};

// A call without a tool to name or without an input that fits its schema
// has no IDs.
const noRefs: ObjectRefList = Object.freeze({
  refs: Object.freeze([]),
  omitted: 0,
});

// Adds IDs to a collector, as the walks of input and output hand them on.
const adder =
  (refs: ObjectRefCollector) =>
  (domain: ObjectDomain, value: unknown): void => {
    refs.add(domain, value);
  };

// The IDs of an input that fits the schema of the tool, and whether each
// value at a field of an ID has the form of one.
const inputRefsOf = (
  entry: CatalogEntry,
  input: unknown,
): { readonly refs: ObjectRefCollector; readonly fits: boolean } => {
  const refs = createObjectRefCollector();
  let fits = true;
  if (entry.inputRefs !== undefined) {
    collectInputRefs(input, entry.inputRefs, (domain, value) => {
      if (!refs.add(domain, value)) fits = false;
    });
  }
  return { refs, fits };
};

/**
 * Builds the pipeline of one ChurchTools instance. It builds the raw client
 * of the instance itself, so the composition root never imports it.
 *
 * @param options - Catalog, audit sink, transport, origin, rate, clock and
 *   where log lines go.
 * @returns The pipeline, frozen.
 * @throws {TypeError} When the client cannot be built from transport,
 *   origin and rate.
 * @example
 * ```ts
 * const pipeline = createToolPipeline({ catalog, audit, transport, origin,
 *   requestsPerMinute: 300, clock, logging: { writer, minLevel: 'info' } });
 * const outcome = await pipeline.call('ct_whoami', {}, request);
 * ```
 */
export function createToolPipeline(options: ToolPipelineOptions): ToolPipeline {
  const { catalog, audit, clock, logging, origin } = options;
  const random = options.random ?? randomBytes;
  // The read budget of the policy, fixed for the life of the pipeline, as
  // the policy is read once at the start (ADR 0032).
  const readBudget = (options.policy ?? defaultPolicy).interactive
    .readBudgetPerDay;
  const exhausted = budgetExhausted(readBudget);
  const client = createChurchToolsClient({
    transport: options.transport,
    origin,
    requestsPerMinute: options.requestsPerMinute,
    clock,
  });
  // The write guard of this pipeline, the only code that writes, built
  // here like the client, so that the composition root never sees either
  // (ADR 0029).
  const guard: WriteGuard = createWriteGuard({
    client,
    clock,
    killSwitchDir: options.killSwitchDir,
  });

  const stages = async (
    run: Run,
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<{
    readonly outcome: ToolOutcome;
    readonly audit: AuditOutcome;
  }> => {
    // 1. Find the tool.
    const entry = catalog.get(name);
    if (entry === undefined) return failed('not_found');
    run.entry = entry;

    // 2. Copies of what the gate, the stages and the audit rely on, taken
    // before any code of the tool runs, and a signal of the call's own.
    // Tenant and actor were copied before the first stage.
    const assignment = run.assignment;
    const mode = request.mode;
    const redaction = request.redaction;
    run.redaction = redaction;
    const readOnly = request.readOnly;
    const features = [...request.features];
    const requestSignal = request.signal;
    // A request the client has already cancelled ends as network, like
    // every aborted call, also without a tenant: the mount stops waiting
    // for the resolver on an abort and passes no tenant (ADR 0024).
    if (isAborted(requestSignal)) return failed('network');
    // Without a tenant, or with an answer the copy could not read, there is
    // no context to run the tool in. The call ends before a listener or a
    // context exists, with one audit line that holds the placeholders and
    // without a log line, since only a context writes one (ADR 0024).
    if (assignment === undefined) return failed('auth');
    const controller = new AbortController();
    const forward = (): void => {
      controller.abort(abortReason);
    };
    Reflect.apply(addListener as () => void, requestSignal, ['abort', forward]);
    run.detach = (): void => {
      Reflect.apply(removeListener as () => void, requestSignal, [
        'abort',
        forward,
      ]);
    };
    const ctx = createTenantContext({
      assignment,
      instance: origin,
      mode,
      redaction,
      readOnly,
      features,
      clock,
      signal: controller.signal,
      logging,
      tool: entry.name,
      eventId: run.eventId,
    });
    run.ctx = ctx;

    // In strict, the pseudonyms of the call and the input with the IDs
    // they stand for, before the gate, so that a call the gate refuses
    // names the IDs of its input in the audit as well (ADR 0028, ADR
    // 0069). Opening derives keys and asks nothing outside the process. A
    // failure ends the call after the gate.
    let keysFailed = false;
    if (isStrictLevel(redaction) && entry.personIds) {
      try {
        if (options.keys === undefined) throw new TypeError('no keys');
        run.pseudonyms = await openPseudonyms(options.keys, ctx);
      } catch {
        keysFailed = true;
      }
      const pseudonyms = run.pseudonyms;
      if (
        pseudonyms !== undefined &&
        entry.inputRefs !== undefined &&
        fitsInput(input)
      ) {
        run.revealed = revealInput(input, entry.inputRefs, pseudonyms.reveal);
      }
    }

    // 3. gate: the rule for running unattended, the licence and, for a tool
    // treated as special and for every write tool, the audit file (ADR
    // 0028, ADR 0029).
    const { meta } = entry;
    const writes = meta.capability === 'write';
    if (meta.unattended === 'never' && mode !== 'interactive') {
      return failed('policy_denied');
    }
    if (meta.tier === 'pro' && features.length === 0) {
      return failed('license_required');
    }
    // Before the input is checked and ChurchTools is asked, so that a
    // broken audit file costs no read and no quota (ADR 0028). A tool that
    // names persons counts here like a special one (ADR 0064).
    if ((entry.asSpecial || writes) && !auditReady()) {
      return failed('policy_denied', auditNotReady);
    }

    // Without its keys, a call in strict cannot turn IDs into pseudonyms.
    if (keysFailed) {
      ctx.log.warn('pseudonym_keys_unavailable');
      return failed('internal');
    }

    // 4. validateInput. The message of zod could repeat the input, so the
    // error carries the fixed sentence only. In strict the schema checks
    // the input with the IDs its pseudonyms stand for.
    if (!fitsInput(input)) return failed('validation');
    if (run.revealed?.ok === false) {
      return failed('validation', pseudonymExpected);
    }
    const parsedInput = entry.input.safeParse(
      run.revealed === undefined ? input : run.revealed.value,
    );
    if (!parsedInput.success) return failed('validation');
    // An ID the audit could not name does not reach ChurchTools (ADR 0028).
    const { refs, fits } = inputRefsOf(entry, parsedInput.data);
    if (!fits) return failed('validation');
    run.refs = refs;

    // The daily read budget, counted once the input is valid and before
    // ChurchTools is asked, so that a call that fails before costs nothing.
    // A call above the budget counts as well, which changes nothing (ADR
    // 0063).
    if (entry.asSpecial) {
      const counted = await countRead(ctx);
      if (counted !== 'ok') {
        ctx.log.warn(
          counted === 'exhausted'
            ? 'read_budget_exhausted'
            : 'read_budget_unavailable',
        );
        return failed(
          'policy_denied',
          counted === 'exhausted' ? exhausted : budgetUnavailable,
        );
      }
      // An abort while the store counted would pass unseen below.
      if (controller.signal.aborted) return failed('network');
    }

    // 5. execute, raced against the signal of the call.
    const access = createReadAccess(
      client,
      ctx,
      entry.meta.sensitivity,
      entry.asSpecial,
      entry.meta.domain,
      adder(refs),
    );
    run.access = access;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(new EccliumError('network'));
        },
        { once: true },
      );
    });
    // Only a write tool gets a write port, valid for this call (ADR 0029).
    const writing = writes ? writeAccess(entry, ctx) : undefined;
    const readCall: ToolCall<unknown> = {
      ctx,
      input: parsedInput.data,
      read: access.read,
    };
    let call = readCall;
    if (writing !== undefined) {
      const writeCall: WriteToolCall<unknown> = {
        ...readCall,
        write: writing.port,
      };
      call = writeCall;
    }
    const executed = Promise.resolve().then(() => entry.execute(call));
    // Whichever loses must not end as an unhandled rejection.
    aborted.catch(() => undefined);
    executed.catch(() => undefined);
    let result: unknown;
    try {
      result = await Promise.race([executed, aborted]);
    } catch (error) {
      // A refused plan ends the call with its own error, whatever the
      // tool made of it.
      const refusal = writing?.refusal();
      if (refusal !== undefined) return writeFailure(run, refusal, false);
      return {
        outcome: Object.freeze({
          __proto__: null,
          ok: false,
          error: describeError(error),
        }),
        audit: 'error',
      };
    } finally {
      access.revoke();
      writing?.revoke();
    }

    // The way of a write after its plan: confirm, commit, and build the
    // result in the fixed form, never from what the tool returned.
    if (writing !== undefined) {
      const refusal = writing.refusal();
      if (refusal !== undefined) return writeFailure(run, refusal, false);
      const written = await completeWrite(
        run,
        ctx,
        writing,
        result,
        () => isAborted(controller.signal),
        refs,
      );
      if (!written.ok) return written.failure;
      result = written.result;
    }

    // 6. validateOutput.
    const parsedOutput = entry.output.safeParse(result);
    if (!parsedOutput.success) {
      ctx.log.warn('tool_output_invalid');
      return failed('internal');
    }
    // A result with an ID the audit could not name does not go out
    // (ADR 0028).
    if (!outputIdsFit(parsedOutput.data, entry.shape.root)) {
      ctx.log.warn('tool_output_invalid');
      return failed('internal');
    }
    run.output = parsedOutput.data as Readonly<Record<string, unknown>>;

    // 7. redact and 8. markUntrusted, along the shape kept at registration.
    // The boundary is drawn after redact, so it is checked against the
    // cleaned text that the envelope will hold.
    const root = entry.shape.root;
    let redacted: unknown;
    try {
      redacted = redact(
        parsedOutput.data,
        root,
        redaction,
        run.pseudonyms?.hide,
      );
    } catch {
      // In strict an ID of a person without its pseudonym never goes out
      // (ADR 0069).
      ctx.log.warn('tool_pseudonym_failed');
      return failed('internal');
    }
    let boundary: string;
    try {
      boundary = chooseBoundary(JSON.stringify(redacted), random);
    } catch {
      ctx.log.warn('tool_boundary_failed');
      return failed('internal');
    }
    const data = markUntrusted(redacted, root, boundary) as Readonly<
      Record<string, unknown>
    >;

    // 9. The size of the result as the client receives it: both copies
    // the mount sends and the reserve for the rest of the message (ADR
    // 0024).
    if (resultBytes(data) > maxResultBytes) {
      ctx.log.warn('tool_result_too_large');
      return failed('upstream', tooLarge);
    }
    // The mark of a redacted result, the only kind the mount sends (ADR
    // 0026).
    return {
      outcome: Object.freeze({
        __proto__: null,
        ok: true,
        data: sealRedacted(data),
      }),
      audit: 'ok',
    };
  };

  // The write port of one call: one plan, and none after the call ended.
  const writeAccess = (
    entry: CatalogEntry,
    ctx: TenantContext,
  ): WriteAccess => {
    let open = true;
    let planned = false;
    let outcome: PlanOutcome | undefined;
    let target: WriteTarget | undefined;
    let refusal: EccliumError | undefined;
    const port: WritePort = Object.freeze({
      plan: async (intent: unknown): Promise<PlanOutcome> => {
        if (!open || planned) throw new EccliumError('internal');
        planned = true;
        try {
          const result = await guard.plan(
            {
              ctx,
              tool: entry.name,
              origin: entry.origin,
              meta: {
                sensitivity: entry.meta.sensitivity,
                unattended: entry.meta.unattended,
              },
            },
            intent,
          );
          outcome = result.outcome;
          target = result.target;
          return result.outcome;
        } catch (error) {
          // The guard rejects only with an EccliumError (write/guard.ts).
          refusal = error as EccliumError;
          throw refusal;
        }
      },
    });
    return Object.freeze({
      port,
      revoke: (): void => {
        open = false;
      },
      outcome: () => outcome,
      target: () => target,
      refusal: () => refusal,
    });
  };

  // A write that ended with an error: its state and outcome for the audit.
  const writeFailure = (
    run: Run,
    error: EccliumError,
    sent: boolean,
    confirmation?: ConfirmationPath,
    state?: 'conflict' | 'failed' | 'denied',
  ): { readonly outcome: ToolOutcome; readonly audit: AuditOutcome } => {
    // The state the guard gives counts over the code: a write that may
    // have landed is never denied.
    const writeState = state ?? writeStateOf(error.code);
    run.write = Object.freeze({
      writeState,
      sent,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
    return {
      outcome: Object.freeze({
        __proto__: null,
        ok: false,
        error: describeError(error),
      }),
      audit: writeState === 'denied' ? 'denied' : 'error',
    };
  };

  // Confirms and commits the plan the tool returned. The tool must return
  // exactly the outcome its plan gave; anything else is a fault of the tool.
  const completeWrite = async (
    run: Run,
    ctx: TenantContext,
    writing: WriteAccess,
    returned: unknown,
    aborted: () => boolean,
    refs: ObjectRefCollector,
  ): Promise<
    | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
    | {
        readonly ok: false;
        readonly failure: {
          readonly outcome: ToolOutcome;
          readonly audit: AuditOutcome;
        };
      }
  > => {
    const outcome = writing.outcome();
    const target = writing.target();
    if (outcome === undefined || target === undefined || returned !== outcome) {
      ctx.log.warn('tool_output_invalid');
      return { ok: false, failure: failed('internal') };
    }
    addTarget(refs, target);
    if (outcome.kind === 'skipped') {
      run.write = Object.freeze({ writeState: 'skipped', sent: false });
      return { ok: true, result: writeResult('skipped', target) };
    }
    const confirmation = await confirmWrite(ctx, outcome.plan);
    if (confirmation.kind === 'required') {
      return {
        ok: false,
        failure: writeFailure(
          run,
          new EccliumError('confirmation_required', confirmationSentence),
          false,
        ),
      };
    }
    if (aborted()) return { ok: false, failure: failed('network') };
    const committed = await guard.commit(ctx, outcome.plan, confirmation.proof);
    if (!committed.ok) {
      return {
        ok: false,
        failure: writeFailure(
          run,
          committed.error,
          committed.sent,
          committed.path,
          committed.state,
        ),
      };
    }
    // A new page names itself only now.
    addTarget(refs, committed.target);
    run.write = Object.freeze({
      writeState: 'verified',
      confirmation: committed.path,
      sent: true,
    });
    return {
      ok: true,
      result: writeResult('verified', committed.target, committed.version),
    };
  };

  // Counts one call against the daily read budget. A store that is
  // missing, throws, takes too long or answers with no count of 1 or more
  // counts as unavailable.
  const countRead = async (
    ctx: TenantContext,
  ): Promise<'ok' | 'exhausted' | 'unavailable'> => {
    const store = options.quota;
    const day = isoDateOf(now());
    if (store === undefined || day === undefined) return 'unavailable';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const counting = Promise.resolve().then(() =>
      store.increment(ctx, 'special_reads', day),
    );
    // Whichever loses must not end as an unhandled rejection.
    counting.catch(() => undefined);
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, quotaTimeoutMs);
    });
    try {
      const counted: unknown = await Promise.race([counting, late]);
      if (
        typeof counted !== 'number' ||
        !Number.isSafeInteger(counted) ||
        counted < 1
      ) {
        return 'unavailable';
      }
      return counted > readBudget ? 'exhausted' : 'ok';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  };

  // Only true counts, and a sink that throws is not ready.
  const auditReady = (): boolean => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
      return audit.ready() === true;
    } catch {
      return false;
    }
  };

  // The IDs of a call for its audit line (ADR 0028). A call that ended
  // before its input was checked, such as one the gate refused, names the
  // IDs of its input if the input fits the schema. Only a call whose stages
  // ended with a result adds the IDs of the persons and groups it names,
  // also when the sink then holds that result back; a result over the
  // limit of size or a failed stage adds none.
  const objectRefsOf = (
    run: Run,
    input: unknown,
    ok: boolean,
  ): ObjectRefList => {
    const entry = run.entry;
    if (entry === undefined) return noRefs;
    let refs = run.refs;
    if (refs === undefined) {
      // In strict the IDs the pseudonyms of the input stand for. An input
      // whose pseudonyms do not open is read as it came, so that a raw ID
      // a model tried is named as well (ADR 0069).
      const source = run.revealed?.ok === true ? run.revealed.value : input;
      const parsed = fitsInput(source)
        ? entry.input.safeParse(source)
        : undefined;
      if (parsed?.success !== true) return noRefs;
      refs = inputRefsOf(entry, parsed.data).refs;
    }
    if (ok && run.output !== undefined) {
      // Walked whole first, so that a walk that fails leaves the IDs of
      // the request as they are.
      const found: [ObjectDomain, unknown][] = [];
      collectOutputRefs(run.output, entry.shape.root, (domain, value) => {
        found.push([domain, value]);
      });
      for (const [domain, value] of found) refs.add(domain, value);
    }
    return refs.list();
  };

  // A clock that throws must not cost the audit of the call.
  const now = (): number => {
    try {
      return clock.now();
    } catch {
      return Number.NaN;
    }
  };

  const call = async (
    name: string,
    input: unknown,
    request: ToolRequest,
  ): Promise<ToolOutcome> => {
    const run: Run = {};
    let outcome = internalOutcome;
    let auditOutcome: AuditOutcome = 'error';
    const start = now();
    let mode: Mode | undefined;
    try {
      // Before the first stage, so that the call of an unknown tool is
      // audited with its tenant as well.
      run.assignment = copyAssignment(request.assignment);
      mode = request.mode;
      // One ID per call, drawn after these copies, so that an ID source
      // that throws still leaves tenant, actor and mode to the audit line,
      // and before the first stage and the first log line. The context
      // binds it to the log lines of the call and the sink writes it into
      // the audit line, so both can be joined (ADR 0054). It travels as an
      // argument of record, never as a field a tool or plugin could set.
      // Without it the sink draws an ID of its own.
      run.eventId = randomUUID();
      ({ outcome, audit: auditOutcome } = await stages(
        run,
        name,
        input,
        request,
      ));
      // A call that fails before the level is copied is masked as standard.
      if (!outcome.ok) {
        const error = maskErrorDescription(
          outcome.error,
          run.redaction ?? 'standard',
        );
        if (error !== outcome.error) {
          outcome = Object.freeze({ __proto__: null, ok: false, error });
        }
      }
    } catch {
      // The outermost catch calls nothing, describeError included.
      outcome = internalOutcome;
      auditOutcome = 'error';
    } finally {
      // Whether the result needs its line in the audit file, read before
      // anything here can throw (ADR 0028, ADR 0064). The result of a write
      // goes out also without its line: it holds no data of ChurchTools,
      // and held back it would make the model write again (ADR 0029).
      const special =
        run.entry?.asSpecial === true && run.entry.meta.capability !== 'write';
      let recorded = false;
      let durationMs = 0;
      try {
        run.access?.revoke();
        run.detach?.();
        const elapsed = Math.round(now() - start);
        durationMs = Number.isFinite(elapsed)
          ? Math.min(Math.max(elapsed, 0), maxDurationMs)
          : 0;
        // Deriving the IDs never costs the line of the call, and a result
        // whose IDs cannot be derived does not go out (ADR 0028).
        let refs = noRefs;
        try {
          refs = objectRefsOf(run, input, outcome.ok);
        } catch {
          // The IDs of the request, as a call without a result names them.
          refs = run.refs?.list() ?? noRefs;
          if (outcome.ok) {
            outcome = internalOutcome;
            auditOutcome = 'error';
          }
        }
        const errorCode = outcome.ok ? undefined : outcome.error.code;
        const writeState = writeStateOfCall(run, auditOutcome, outcome.ok);
        // Tenant and actor come from the frozen copy only, which runs no
        // code of the resolver's answer. Without one the audit takes its
        // placeholders, which no context accepts as real values, so a call
        // without a tenant is no invalid field for the sink to report.
        // Only true counts, also from a sink without types.
        recorded =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- see above
          audit.record(
            {
              type: 'tool_call',
              tenantId: run.assignment?.tenantId ?? auditPlaceholders.tenantId,
              actor: run.assignment?.actor ?? auditPlaceholders.actor,
              // An invalid value becomes a placeholder in the sink.
              mode: mode as Mode,
              tool: run.entry?.name ?? 'ct_unknown',
              outcome: auditOutcome,
              ...(run.write?.confirmation === undefined
                ? {}
                : { confirmation: run.write.confirmation }),
              ...(writeState === undefined ? {} : { writeState }),
              ...(errorCode === undefined ? {} : { errorCode }),
              objectRefs: refs.refs,
              ...(refs.omitted > 0 ? { objectRefsOmitted: refs.omitted } : {}),
              durationMs,
            },
            run.eventId,
            { required: special && outcome.ok },
          ) === true;
      } catch {
        // The audit never decides the outcome of a reading call, except
        // for the result of a tool treated as special below.
      }
      // After a call that may have written: an anchor of the chain on the
      // log, and when its line did not reach the audit file, no further
      // write until the process ends (ADR 0029).
      if (run.write?.sent === true) {
        if (!recorded) {
          guard.block();
          try {
            run.ctx?.log.error('write_audit_failed');
          } catch {
            // The block holds without its log line.
          }
        }
        try {
          audit.anchor?.();
        } catch {
          // The anchor is lost; the line is in the file or reported.
        }
      }
      // The keys of the call go once its line is written, also after a
      // failure (ADR 0069).
      try {
        run.pseudonyms?.erase();
      } catch {
        // Erasing only fills bytes with zeros; nothing is left to undo.
      }
      // Whatever threw above: the result of a tool treated as special goes
      // out only with its line in the audit file (ADR 0028).
      const withheld = outcome.ok && special && !recorded;
      if (withheld) outcome = withheldOutcome;
      try {
        const errorCode = outcome.ok ? undefined : outcome.error.code;
        if (withheld) {
          run.ctx?.log.warn('audit_withheld', { code: 'policy_denied' });
        }
        run.ctx?.log.info('tool_call', {
          durationMs,
          ...(errorCode === undefined ? {} : { code: errorCode }),
        });
      } catch {
        // The log never decides the outcome.
      }
    }
    return outcome;
  };

  return Object.freeze({ __proto__: null, call });
}
