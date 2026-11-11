/**
 * The metrics file of the runner on disk (ADR 0033): read the last one,
 * merge what a pass found, replace it whole. `ecclium run-once` and the
 * daemon both go through here, so that a run by hand beside a daemon
 * carries the values of the daemon and the other way round.
 *
 * Where it stands: in the composition root, after a pass. The form of the
 * text is in the package `runner`; this module only reads and writes the
 * file, privately like every file of Ecclium: its folder 700, the file
 * 600, replaced in one step, so that a monitoring never reads half a file
 * (decided on 11.11.2026). The file mirrors only and never decides about
 * a run.
 *
 * @packageDocumentation
 */
import {
  readPrivateFile,
  replacePrivateFile,
} from '@ecclium/mcp-churchtools-core/composition';
import {
  type MetricsUpdate,
  readRunnerMetrics,
  renderRunnerMetrics,
  type RunnerMetrics,
  updateRunnerMetrics,
} from '@ecclium/mcp-churchtools-runner';

/** The largest metrics file read back, far above what a runner writes. */
export const maxMetricsBytes = 1_048_576;

/**
 * The folder of the metrics file, which the runner prepares as a private
 * one at its start.
 *
 * @param path - The absolute, normalised path of the file.
 * @returns The path of its folder.
 * @example
 * ```ts
 * metricsFolderOf('/data/metrics/runner.prom'); // '/data/metrics'
 * ```
 */
export const metricsFolderOf = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
};

// The last file, as the runner wrote it, or undefined when there is none
// or it is not one of its own.
const readLast = (folder: string, name: string): RunnerMetrics | undefined => {
  try {
    const bytes = readPrivateFile(folder, name, maxMetricsBytes);
    if (bytes === undefined) return undefined;
    return readRunnerMetrics(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    // A file the checks refuse is replaced like one that is not its own;
    // the value is never looked at.
    return undefined;
  }
};

/**
 * Reads the last metrics file, merges what a pass or a call found and
 * replaces the file whole.
 *
 * @param path - The absolute, normalised path from
 *   `ECCLIUM_RUNNER_METRICS_FILE`.
 * @param update - What the pass found, without the last metrics.
 * @param pid - The ID of the process, for the temporary name.
 * @returns Whether the file holds the new metrics. It never throws.
 * @example
 * ```ts
 * const ok = updateMetricsFile(config.metricsFile, { routineIds, refused, reports, next, chain }, process.pid);
 * ```
 */
export function updateMetricsFile(
  path: string,
  update: Omit<MetricsUpdate, 'previous'>,
  pid: number,
): boolean {
  const folder = metricsFolderOf(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    const text = renderRunnerMetrics(
      updateRunnerMetrics({ ...update, previous: readLast(folder, name) }),
    );
    replacePrivateFile(folder, name, new TextEncoder().encode(text), { pid });
    return true;
  } catch {
    // The value is never looked at: it could name the path.
    return false;
  }
}
