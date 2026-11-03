/**
 * The pipeline of the tools as the composition root builds it (ADR 0056),
 * shared by the start over stdio and `ecclium policy init`, so that both
 * reach ChurchTools in the same way: the transport to the instance, the
 * keys for pseudonyms in the level `strict` (ADR 0069), the day keys in
 * the folder of keys and the snapshots of writes over them and the folder
 * of state (ADR 0031), the audit sink
 * with the audit file, the store of the counters and the folder of the
 * kill switches in the folder of state (ADR 0028, ADR 0029, ADR 0063),
 * the policy (ADR 0032), and how writes are confirmed, with the stores of
 * plans and nonces of the questions before a write (ADR 0029) and the
 * queue of approvals over the day keys and the folder of state (ADR 0031).
 * The start over stdio reaches this module, so
 * it writes nothing to stdout and loads no module that does (ADR 0053).
 *
 * @packageDocumentation
 */
import { hostname } from 'node:os';

import {
  createToolPipeline,
  type EccliumConfig,
  type ToolCatalog,
  type ToolPipeline,
} from '@ecclium/mcp-churchtools-core';
import {
  type AuditFileWriter,
  createAuditSink,
  createDefaultTenantLogger,
  createFileApprovalQueue,
  createFileDayKeys,
  createFileKeyProvider,
  createFileQuotaStore,
  createFileSnapshotStore,
  createMemoryNonceStore,
  createMemoryPlanStore,
  createQueueKeeper,
  createSnapshotKeeper,
  type DayKeys,
  type QueueKeeper,
  type SnapshotKeeper,
  type StderrLineWriter,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { userAgent } from '../version.js';
import { keepsSnapshots } from './snapshots.js';

/** What the pipeline is built from. */
export interface ComposeOptions {
  /** The checked configuration. */
  readonly config: EccliumConfig;
  /** The catalog of tools that the registry accepted. */
  readonly catalog: ToolCatalog;
  /** The one stderr writer of the process, for logs and the audit copy. */
  readonly writer: StderrLineWriter;
  /** The clock of the process. */
  readonly clock: Clock;
  /** The audit file of the process, if the folder of state is set. */
  readonly auditFile?: AuditFileWriter | undefined;
  /**
   * Replaces the factory of the transport, such as with the test double of
   * ChurchTools. It gets what the real factory would get.
   */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
}

/**
 * The pipeline, the transport it sends through, its day keys and its
 * snapshots.
 */
export interface ComposedPipeline {
  /** The pipeline of the tools. */
  readonly pipeline: ToolPipeline;
  /** The transport, which the caller closes when it is done. */
  readonly transport: HttpTransport;
  /**
   * The day keys the pipeline got, over the folder of keys, or undefined
   * without one (ADR 0031). Without a folder of state the start over
   * stdio destroys those past their retention through them; with one it
   * goes through the snapshots, which destroy them as well.
   */
  readonly dayKeys: DayKeys | undefined;
  /**
   * The snapshots of writes over the folder of keys and the folder of
   * state, or undefined without one of them (ADR 0031). The start over
   * stdio removes those past their retention through them, records and
   * day keys alike, also while the server only reads. The pipeline got
   * them only when its writes keep snapshots, see `keepsSnapshots`.
   */
  readonly snapshots: SnapshotKeeper | undefined;
  /**
   * The queue of approvals over the folder of keys and the folder of
   * state, or undefined without one of them (ADR 0031). The pipeline gets
   * it whenever it exists: a server that only reads queues nothing, but
   * `ecclium queue` can still decide about entries of an earlier run, and
   * the start removes those past their retention.
   */
  readonly queue: QueueKeeper | undefined;
}

/**
 * Builds the transport and the pipeline over it. When the pipeline cannot
 * be built, the transport closes again before the error goes on, so that
 * the caller holds nothing to close.
 *
 * @param options - Configuration, catalog, writer, clock, audit file and
 *   a replacement for tests.
 * @returns The pipeline, its transport, its day keys and its snapshots.
 * @throws {TypeError} When the level `strict` has no key, or when a factory
 *   of core refuses its options.
 * @example
 * ```ts
 * const { pipeline, transport } = composeToolPipeline({
 *   config, catalog, writer, clock: systemClock, auditFile,
 * });
 * ```
 */
export function composeToolPipeline(options: ComposeOptions): ComposedPipeline {
  const { config, catalog, writer, clock, auditFile } = options;
  const minLevel = config.logLevel;
  const transport = (options.createTransport ?? createHttpTransport)({
    origin: config.churchtoolsOrigin,
    token: config.churchtoolsToken,
    userAgent,
    // Bound to the tenant default, so that the lines of the transport
    // name the same tenant as the lines and the audit of a call.
    logger: createDefaultTenantLogger({ writer, clock, minLevel }),
    clock,
  });
  try {
    // The keys for the pseudonyms of the level strict, from the key files
    // the loader read (ADR 0069). The loader refuses strict without a key,
    // and so does this, so that no call runs without one.
    if (config.redaction === 'strict' && config.pseudonymKey === undefined) {
      throw new TypeError('The level strict has no key.');
    }
    const strict =
      config.redaction === 'strict' && config.pseudonymKey !== undefined;
    // The day keys in the folder of keys, for the snapshots of writes and
    // the queue (ADR 0031). They hold the folder only, no key, and touch
    // the disk only when a key is wrapped, opened or destroyed. One
    // provider carries them and, in strict, the secrets of the pseudonyms.
    const dayKeys =
      config.keysDir === undefined
        ? undefined
        : createFileDayKeys({ keysDir: config.keysDir, pid: process.pid });
    const keys =
      strict || dayKeys !== undefined
        ? createFileKeyProvider({
            ...(strict
              ? {
                  current: config.pseudonymKey,
                  previous: config.pseudonymKeyPrevious,
                }
              : {}),
            ...(dayKeys === undefined ? {} : { dayKeys }),
          })
        : undefined;
    // The snapshots of writes: their records in the folder snapshots of
    // the folder of state, their keys wrapped by the day keys of the same
    // provider (ADR 0031). They exist with both folders, so that the start
    // removes records past their retention also in a run that only reads
    // or keeps none. The pipeline gets them only when its writes keep
    // snapshots, in a folder the first stage prepared; without them every
    // write is sealed as not reversible.
    const snapshots =
      dayKeys !== undefined &&
      keys !== undefined &&
      config.stateDir !== undefined
        ? createSnapshotKeeper({
            keys,
            store: createFileSnapshotStore({
              stateDir: config.stateDir,
              pid: process.pid,
            }),
          })
        : undefined;
    const writeSnapshots = keepsSnapshots(config) ? snapshots : undefined;
    // The queue of approvals: its entries in the folder queue of the
    // folder of state, their keys wrapped by the day keys queue of the same
    // provider (ADR 0031). Over both folders, like the snapshots.
    const queue =
      dayKeys !== undefined &&
      keys !== undefined &&
      config.stateDir !== undefined
        ? createQueueKeeper({
            keys,
            store: createFileApprovalQueue({
              stateDir: config.stateDir,
              pid: process.pid,
            }),
            clock,
          })
        : undefined;
    const pipeline = createToolPipeline({
      catalog,
      audit: createAuditSink({
        writer,
        clock,
        isKnownTool: catalog.has,
        ...(auditFile === undefined ? {} : { file: auditFile }),
      }),
      transport,
      origin: config.churchtoolsOrigin,
      requestsPerMinute: config.churchtoolsRequestsPerMinute,
      clock,
      logging: { writer, minLevel },
      // The checked policy, for the read budget and the limits of writes
      // (ADR 0032).
      policy: config.policy,
      // The counters of the read budget and of the writes, in the folder
      // the first stage prepared. Without the folder of state there is no
      // store: no tool with sensitivity special runs (ADR 0063), and no
      // write that an entry of the policy limits.
      ...(config.stateDir === undefined
        ? {}
        : {
            quota: createFileQuotaStore({
              stateDir: config.stateDir,
              clock,
              pid: process.pid,
              host: hostname(),
            }),
            // The kill switches of writing: the folder stop of the folder
            // of state. Nothing makes it; without it, writing stays off
            // (ADR 0029).
            killSwitchDir: `${config.stateDir}/stop`,
          }),
      ...(keys === undefined ? {} : { keys }),
      ...(writeSnapshots === undefined ? {} : { snapshots: writeSnapshots }),
      // How a write is confirmed, and, for a server that writes, the plans
      // that wait for an answer and the nonces of the answers, in memory,
      // so that a restart forgets them (ADR 0029).
      confirmation: config.writeConfirmation,
      ...(config.readOnly
        ? {}
        : {
            plans: createMemoryPlanStore(clock),
            nonces: createMemoryNonceStore(clock),
          }),
      ...(queue === undefined ? {} : { queue }),
    });
    return Object.freeze({ pipeline, transport, dayKeys, snapshots, queue });
  } catch (error) {
    // The caller never got the transport, so it closes here.
    void transport.close().catch(() => undefined);
    throw error;
  }
}
