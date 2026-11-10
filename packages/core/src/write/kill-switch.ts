/**
 * The kill switches of writing (ADR 0029): files whose presence stops
 * every write, without a restart.
 *
 * Where it stands in the way of a write: the core looks here before it
 * plans and again right before it commits. `writes-off` in the folder
 * stops every write, `writes-off-<tenant>` those of one tenant, and
 * `writes-off-routine-<routine>` those of the runs of one routine and the
 * approvals of what they queued. Only that the file is there
 * counts, never what it holds, and the core follows no link to find it. A
 * folder that cannot be checked stops writing as well: a switch the core
 * cannot see must not count as off.
 *
 * The operator makes the files on the host. In a container the folder is
 * mounted read-only, which is enough, because the core only looks.
 *
 * @packageDocumentation
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isProxy } from 'node:util/types';

import { isNormalizedAbsolutePath } from '../config/state-dir.js';
import { isTenantId } from '../logger/index.js';

/** The file that stops every write. */
export const globalKillSwitch = 'writes-off';

/**
 * The file that stops the writes of one tenant.
 *
 * @param tenantId - The tenant, as the context names it.
 * @returns The name of the file.
 * @example
 * ```ts
 * tenantKillSwitchOf('demo-tenant'); // 'writes-off-demo-tenant'
 * ```
 */
export function tenantKillSwitchOf(tenantId: string): string {
  return `${globalKillSwitch}-${tenantId}`;
}

/**
 * What the switches say: writing is on, a switch stops it, or the folder
 * could not be checked, which stops it as well.
 */
export type KillSwitchState = 'on' | 'off' | 'unknown';

/** The one call of the file system the check makes, for tests. */
export interface KillSwitchFileSystem {
  readonly lstatSync: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
}

const system: KillSwitchFileSystem = Object.freeze({ lstatSync });

// The code of a failed system call, read as an own data property, so that
// no getter runs and the message, which holds the path, never leaves.
const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && !isProxy(error)
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value
    : undefined;

// Whether a file is there, without following a link: true when it is,
// false when it is not, undefined when the call fails otherwise.
const present = (
  fs: KillSwitchFileSystem,
  path: string,
): boolean | undefined => {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? false : undefined;
  }
};

/**
 * Checks the kill switches for a tenant.
 *
 * @param dir - The folder of the switches, an absolute path.
 * @param tenantId - The tenant of the write.
 * @param fs - The file system; the real one unless a test replaces it.
 * @returns `on` when no switch is there, `off` when one is, `unknown` when
 *   the folder is no real folder or cannot be read, or the tenant cannot
 *   name a file.
 * @example
 * ```ts
 * if (checkKillSwitches(dir, ctx.tenantId) !== 'on') return refused();
 * ```
 */
export function checkKillSwitches(
  dir: string,
  tenantId: string,
  fs: KillSwitchFileSystem = system,
): KillSwitchState {
  if (!isNormalizedAbsolutePath(dir) || !isTenantId(tenantId)) {
    return 'unknown';
  }
  return lookFor(dir, [globalKillSwitch, tenantKillSwitchOf(tenantId)], fs);
}

/**
 * The file that stops the writes of the runs of one routine (ADR 0029).
 * A tenant whose ID starts with `routine-` has a file of the same name as
 * a routine; both stop then, neither opens.
 *
 * @param routineId - The ID of the routine, as the policy names it.
 * @returns The name of the file.
 * @example
 * ```ts
 * routineKillSwitchOf('dienstplan-report'); // 'writes-off-routine-dienstplan-report'
 * ```
 */
export function routineKillSwitchOf(routineId: string): string {
  return `${globalKillSwitch}-routine-${routineId}`;
}

/**
 * Checks the kill switches for a write of a run of a routine: the one of
 * every write, the one of the tenant and the one of the routine.
 *
 * @param dir - The folder of the switches, an absolute path.
 * @param tenantId - The tenant of the write.
 * @param routineId - The routine of the run.
 * @param fs - The file system; the real one unless a test replaces it.
 * @returns As {@link checkKillSwitches}, and `unknown` as well for a
 *   routine whose ID cannot name a file.
 * @example
 * ```ts
 * if (checkRunKillSwitches(dir, ctx.tenantId, routine) !== 'on') return refused();
 * ```
 */
export function checkRunKillSwitches(
  dir: string,
  tenantId: string,
  routineId: string,
  fs: KillSwitchFileSystem = system,
): KillSwitchState {
  if (
    !isNormalizedAbsolutePath(dir) ||
    !isTenantId(tenantId) ||
    !isTenantId(routineId)
  ) {
    return 'unknown';
  }
  return lookFor(
    dir,
    [
      globalKillSwitch,
      tenantKillSwitchOf(tenantId),
      routineKillSwitchOf(routineId),
    ],
    fs,
  );
}

// Whether one of the files is in the folder, which must be a real folder.
const lookFor = (
  dir: string,
  names: readonly string[],
  fs: KillSwitchFileSystem,
): KillSwitchState => {
  try {
    // The folder itself, without following a link: a link could point
    // the core at a folder the operator never looks into.
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return 'unknown';
  } catch {
    return 'unknown';
  }
  let state: KillSwitchState = 'on';
  for (const name of names) {
    const found = present(fs, join(dir, name));
    if (found === undefined) return 'unknown';
    if (found) state = 'off';
  }
  return state;
};
