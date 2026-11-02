/**
 * The pipeline of the tools as the composition root builds it (ADR 0056),
 * shared by the start over stdio and `ecclium policy init`, so that both
 * reach ChurchTools in the same way: the transport to the instance, the
 * keys for pseudonyms in the level `strict` (ADR 0069), the audit sink
 * with the audit file, the store of the counters and the folder of the
 * kill switches in the folder of state (ADR 0028, ADR 0029, ADR 0063),
 * and the policy (ADR 0032). The start over stdio reaches this module, so
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
  createFileKeyProvider,
  createFileQuotaStore,
  type StderrLineWriter,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock } from '@ecclium/mcp-churchtools-plugin-api';

import { userAgent } from '../version.js';

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

/** The pipeline and the transport it sends through. */
export interface ComposedPipeline {
  /** The pipeline of the tools. */
  readonly pipeline: ToolPipeline;
  /** The transport, which the caller closes when it is done. */
  readonly transport: HttpTransport;
}

/**
 * Builds the transport and the pipeline over it. When the pipeline cannot
 * be built, the transport closes again before the error goes on, so that
 * the caller holds nothing to close.
 *
 * @param options - Configuration, catalog, writer, clock, audit file and
 *   a replacement for tests.
 * @returns The pipeline and its transport.
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
    const keys =
      config.redaction === 'strict' && config.pseudonymKey !== undefined
        ? createFileKeyProvider({
            current: config.pseudonymKey,
            previous: config.pseudonymKeyPrevious,
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
    });
    return Object.freeze({ pipeline, transport });
  } catch (error) {
    // The caller never got the transport, so it closes here.
    void transport.close().catch(() => undefined);
    throw error;
  }
}
