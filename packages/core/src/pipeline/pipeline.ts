/**
 * The one pipeline every call of a tool runs through (ADR 0024). Its
 * stages are fixed in this code; no plugin adds or removes one:
 *
 * 1. find the tool in the catalog,
 * 2. make the context of the call, with a signal of its own,
 * 3. `gate`,
 * 4. `validateInput`,
 * 5. `execute` with read access that is revoked afterwards,
 * 6. `validateOutput`, which drops every field the schema does not declare,
 * 7. `redact` and 8. `markUntrusted` with a boundary drawn for the call,
 * 9. the limit on the size of the result,
 * 10. `audit`, in `finally`, also when a stage fails.
 *
 * The message of a failed call is masked like a result before it leaves.
 *
 * `serialize`, the only stage that knows MCP, lives in the mount.
 *
 * @packageDocumentation
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  type AuditOutcome,
  type Clock,
  EccliumError,
  type ErrorCode,
  type FeatureKey,
  type Mode,
  type RedactionLevel,
  type TenantAssignment,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { AuditSink } from '../audit/index.js';
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
  maskErrorDescription,
  type RandomBytes,
} from '../redaction/index.js';
import type { CatalogEntry, ToolCatalog } from '../registry/index.js';
import { createTenantContext } from '../tenant/context.js';
import { createReadAccess, type ReadAccess } from './read-api.js';
import {
  fitsInput,
  markUntrusted,
  maxResultBytes,
  redact,
  resultBytes,
} from './stages.js';

/** What the mount knows about one call, besides name and input. */
export interface ToolRequest {
  /** Tenant and actor, from the resolver of the checked identity. */
  readonly assignment: TenantAssignment;
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

/** What a call returns, before the mount turns it into MCP. */
export type ToolOutcome =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>> }
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

const tooLarge =
  'The result is larger than 64 KiB. Narrow the request, for example with a more specific search.';

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
  entry?: CatalogEntry;
  redaction?: RedactionLevel;
  ctx?: TenantContext;
  access?: ReadAccess;
  detach?: () => void;
}

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
  const client = createChurchToolsClient({
    transport: options.transport,
    origin,
    requestsPerMinute: options.requestsPerMinute,
    clock,
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
    const mode = request.mode;
    const redaction = request.redaction;
    run.redaction = redaction;
    const readOnly = request.readOnly;
    const features = [...request.features];
    const requestSignal = request.signal;
    const controller = new AbortController();
    const forward = (): void => {
      controller.abort(abortReason);
    };
    if (isAborted(requestSignal)) return failed('network');
    Reflect.apply(addListener as () => void, requestSignal, ['abort', forward]);
    run.detach = (): void => {
      Reflect.apply(removeListener as () => void, requestSignal, [
        'abort',
        forward,
      ]);
    };
    const ctx = createTenantContext({
      assignment: request.assignment,
      instance: origin,
      mode,
      redaction,
      readOnly,
      features,
      clock,
      signal: controller.signal,
      logging,
      tool: entry.name,
      eventId: randomUUID(),
    });
    run.ctx = ctx;

    // 3. gate. Every write is refused until the core can confirm one.
    const { meta } = entry;
    if (meta.capability === 'write') return failed('policy_denied');
    if (meta.unattended === 'never' && mode !== 'interactive') {
      return failed('policy_denied');
    }
    if (meta.tier === 'pro' && features.length === 0) {
      return failed('license_required');
    }

    // 4. validateInput. The message of zod could repeat the input, so the
    // error carries the fixed sentence only.
    if (!fitsInput(input)) return failed('validation');
    const parsedInput = entry.input.safeParse(input);
    if (!parsedInput.success) return failed('validation');

    // 5. execute, raced against the signal of the call.
    const access = createReadAccess(client, ctx);
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
    const executed = Promise.resolve().then(() =>
      entry.execute({ ctx, input: parsedInput.data, read: access.read }),
    );
    // Whichever loses must not end as an unhandled rejection.
    aborted.catch(() => undefined);
    executed.catch(() => undefined);
    let result: unknown;
    try {
      result = await Promise.race([executed, aborted]);
    } catch (error) {
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
    }

    // 6. validateOutput.
    const parsedOutput = entry.output.safeParse(result);
    if (!parsedOutput.success) {
      ctx.log.warn('tool_output_invalid');
      return failed('internal');
    }

    // 7. redact and 8. markUntrusted, along the shape kept at registration.
    // The boundary is drawn after redact, so it is checked against the
    // cleaned text that the envelope will hold.
    const root = entry.shape.root;
    const redacted = redact(parsedOutput.data, root, redaction);
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

    // 9. The size of the result.
    if (resultBytes(data) > maxResultBytes) {
      ctx.log.warn('tool_result_too_large');
      return failed('upstream', tooLarge);
    }
    return {
      outcome: Object.freeze({ __proto__: null, ok: true, data }),
      audit: 'ok',
    };
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
    let assignment: TenantAssignment | undefined;
    let mode: Mode | undefined;
    try {
      assignment = request.assignment;
      mode = request.mode;
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
      try {
        run.access?.revoke();
        run.detach?.();
        const elapsed = Math.round(now() - start);
        const durationMs = Number.isFinite(elapsed)
          ? Math.min(Math.max(elapsed, 0), maxDurationMs)
          : 0;
        const errorCode = outcome.ok ? undefined : outcome.error.code;
        audit.record({
          type: 'tool_call',
          tenantId: assignment?.tenantId ?? '',
          actor: assignment?.actor ?? { kind: 'service', id: '' },
          // An invalid value becomes a placeholder in the sink.
          mode: mode as Mode,
          tool: run.entry?.name ?? 'ct_unknown',
          outcome: auditOutcome,
          ...(errorCode === undefined ? {} : { errorCode }),
          objectRefs: [],
          durationMs,
        });
        run.ctx?.log.info('tool_call', {
          durationMs,
          ...(errorCode === undefined ? {} : { code: errorCode }),
        });
      } catch {
        // Audit and log never decide the outcome of a reading call.
      }
    }
    return outcome;
  };

  return Object.freeze({ __proto__: null, call });
}
