/**
 * Whether the composition root keeps snapshots of writes (ADR 0031). The
 * first stage of the start over stdio prepares their folder by it, and
 * the build of the pipeline builds them by it, so that both stages agree.
 * It loads nothing but types, so that the first stage can import it
 * before the server, its SDK and undici (ADR 0054).
 *
 * @packageDocumentation
 */
import type { EccliumConfig } from '@ecclium/mcp-churchtools-core';

/** A configuration whose writes keep snapshots, with both folders set. */
export type SnapshotConfig = EccliumConfig & {
  readonly keysDir: string;
  readonly stateDir: string;
};

/**
 * Asks whether the writes of a configuration keep snapshots: only a server
 * that writes, with snapshots on, a folder of keys for their day keys and
 * a folder of state for their records. A server that only reads keeps
 * none, and one without the folder of state writes nothing at all, because
 * its kill switches lie there (ADR 0029).
 *
 * @param config - The checked configuration.
 * @returns Whether the composition builds the snapshots.
 * @example
 * ```ts
 * if (keepsSnapshots(config)) prepareSnapshotFolder(config.stateDir);
 * ```
 */
export function keepsSnapshots(
  config: EccliumConfig,
): config is SnapshotConfig {
  return (
    !config.readOnly &&
    config.snapshots &&
    config.keysDir !== undefined &&
    config.stateDir !== undefined
  );
}
