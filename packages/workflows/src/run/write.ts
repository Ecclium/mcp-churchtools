/**
 * The write of a run of a routine (ADR 0032, ADR 0033): the rendered
 * section into the page of the wiki that the entry of the policy names.
 *
 * Where it stands in a run: right after `executeRun`, which gives the
 * section, and only when that ended `rendered`. A trial run calls
 * `executeRun` and stops; it never calls this. What the write needs
 * beyond the section the engine never sees: the composition root binds
 * tenant, actor, mode, run, the data the reads gave, the tools of the
 * account and the counter of the writes of the run into the port, and the
 * core finds the page, plans the section with the marking of the run and
 * writes it with the proof of the policy or puts it in the queue of
 * approvals.
 *
 * The engine names the page only as the policy does: a page by its GUID,
 * or a category by its ID with the name of the page from the routine,
 * which the core compares in NFC.
 *
 * Tried again here, once: a write that ended in a conflict before it was
 * sent, because the page changed between the plan and the read right
 * before the write. The core reads the page anew for each call, and a
 * conflict before the send counts in neither limit of the policy, because
 * the core counts a write only right before it sends it; a run creates no
 * page, whose name could conflict later. Every
 * other failure goes to the runner with whether a later run may pass
 * (ADR 0034); a write that may have reached ChurchTools is never tried
 * again here, since the marking of the run keeps a later run from adding
 * it twice.
 *
 * The signal of the run reaches the core with each call: it ends the
 * search of the page, which for a whole category reads the list of its
 * pages, and keeps the second try from beginning. A write whose page the
 * core has found runs to its end, so that the grace of a stopping
 * container covers it (ADR 0036).
 *
 * @packageDocumentation
 */
import type {
  RunPageRef,
  RunWriteOutcome,
  UnattendedEntry,
} from '@ecclium/mcp-churchtools-core';
import type {
  Clock,
  ErrorCode,
  Logger,
} from '@ecclium/mcp-churchtools-plugin-api';

import type { RunResult } from './execute.js';

/** What the engine gives the write of a run. */
export interface RunWriteCall {
  /** The write tool of the output of the routine. */
  readonly tool: string;
  /** The period of the run, which the line of the marking names. */
  readonly period: string;
  /** The section, without the line of the marking. */
  readonly section: string;
  /** The page, as the entry of the policy names it. */
  readonly page: RunPageRef;
}

/**
 * The write of a run, built by the composition root over the pipeline. It
 * carries tenant, actor, mode, run, the data of the run, the tools of the
 * account and the counter of the writes of the run; the engine gives only
 * tool, period, section and page.
 */
export type RunWrite = (
  call: RunWriteCall,
  signal: AbortSignal,
) => Promise<RunWriteOutcome>;

/** What the composition root gives the write of a run. */
export interface RunWritePorts {
  /** Writes with the actor of the routine in the mode `unattended`. */
  readonly write: RunWrite;
  /** The logger of the run. */
  readonly log: Logger;
  /** The clock of the core. */
  readonly clock: Clock;
}

/** A section a run rendered. */
export type RenderedRun = Extract<RunResult, { readonly kind: 'rendered' }>;

/** The target of a write the core names: its kind and its key. */
export type RunWriteTarget = Extract<
  RunWriteOutcome,
  { readonly ok: true }
>['target'];

/** How the write of a run ended. */
export type RunWriteResult =
  | {
      /** The section stands on the page, read back as written. */
      readonly kind: 'written';
      readonly target: RunWriteTarget;
      readonly version: number;
      /** The ID for `ecclium undo`, when the write keeps a snapshot. */
      readonly undoId?: string;
      /** 2 when a conflict before the send was tried again. */
      readonly attempts: 1 | 2;
    }
  | {
      /** The page holds the section of this period as written already. */
      readonly kind: 'skipped';
      readonly target: RunWriteTarget;
    }
  | {
      /** The section waits in the queue of approvals for the operator. */
      readonly kind: 'queued';
      readonly target: RunWriteTarget;
      readonly queueId: string;
    }
  | {
      readonly kind: 'failed';
      /** The code of the core, such as `conflict` or `policy_denied`. */
      readonly code: ErrorCode;
      /** Whether a later try would end the same, so the trigger closes. */
      readonly final: boolean;
      /** Whether the write may have reached ChurchTools. */
      readonly sent: boolean;
      /** Why the core found no page, when it found none. */
      readonly page?: 'missing' | 'ambiguous';
    };

// The page as the entry of the policy names it. Only the targets of the
// wiki can be the target of a routine with an output in the wiki; the
// preparation of the run holds that.
const pageOf = (
  target: UnattendedEntry['target'],
  title: string,
): RunPageRef => {
  switch (target.kind) {
    case 'wiki_page':
      return { categoryId: target.categoryId, guid: target.guid };
    case 'wiki_category':
      return { categoryId: target.id, title };
    default:
      throw new TypeError('The target of the run is not one of the wiki.');
  }
};

/**
 * Writes the section of a rendered run to the wiki.
 *
 * @param run - The section `executeRun` rendered, with an output in the
 *   wiki and the entry of the policy for its target.
 * @param ports - Write, logger and clock of the run.
 * @param signal - The signal of the run: it ends the search of the page
 *   and keeps a second write after a conflict from beginning. A write
 *   whose page the core has found runs to its end (ADR 0036).
 * @returns How the write ended. It never throws for a failure of
 *   ChurchTools, the policy or the checks of the core.
 * @throws {TypeError} When the run has no output in the wiki or no entry
 *   of the policy for it, which only a caller that skips the preparation
 *   can make, or comes from a routine prepared for a preview: a draft goes
 *   another way, and a preview writes nothing.
 * @example
 * ```ts
 * const rendered = await executeRun(prepared, trigger, ports, signal);
 * if (rendered.kind === 'rendered' && !trial) {
 *   const written = await writeRun(rendered, { write, log, clock }, signal);
 * }
 * ```
 */
export async function writeRun(
  run: RenderedRun,
  ports: RunWritePorts,
  signal: AbortSignal,
): Promise<RunWriteResult> {
  const { output, target } = run;
  if (output.target !== 'wiki' || target === undefined) {
    throw new TypeError('Only a run with a target in the wiki writes here.');
  }
  if (run.preview === true) {
    throw new TypeError('A preview writes nothing.');
  }
  const { log, clock } = ports;
  const call: RunWriteCall = Object.freeze({
    tool: output.tool,
    period: run.period,
    section: run.section,
    page: Object.freeze(pageOf(target.target, output.scope.page)),
  });
  const start = clock.now();

  let attempts: 1 | 2 = 1;
  let outcome = await ports.write(call, signal);
  // A page twice in its category is a conflict as well, but a final one:
  // only a page that changed is tried again.
  if (
    !outcome.ok &&
    outcome.code === 'conflict' &&
    outcome.page === undefined &&
    !outcome.sent &&
    !signal.aborted
  ) {
    log.info('run_write_retried', { code: 'conflict' });
    attempts = 2;
    outcome = await ports.write(call, signal);
  }

  if (!outcome.ok) {
    log.warn('run_write_failed', { code: outcome.code });
    return Object.freeze({
      kind: 'failed',
      code: outcome.code,
      final: !outcome.transient,
      sent: outcome.sent,
      ...(outcome.page === undefined ? {} : { page: outcome.page }),
    });
  }
  switch (outcome.state) {
    case 'verified':
      log.info('run_written', {
        durationMs: Math.min(
          Math.max(Math.round(clock.now() - start), 0),
          86_400_000,
        ),
      });
      return Object.freeze({
        kind: 'written',
        target: outcome.target,
        version: outcome.version,
        ...(outcome.undoId === undefined ? {} : { undoId: outcome.undoId }),
        attempts,
      });
    case 'skipped':
      log.info('run_write_skipped');
      return Object.freeze({ kind: 'skipped', target: outcome.target });
    case 'queued':
      log.info('run_write_queued');
      return Object.freeze({
        kind: 'queued',
        target: outcome.target,
        queueId: outcome.queueId,
      });
  }
}
