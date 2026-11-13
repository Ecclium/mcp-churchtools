/**
 * The part of `ecclium doctor` for the accounts of the runner (ADR 0032,
 * ADR 0033): for its own account and each alias of the policy, which
 * routines it serves, which of them do not start, and which of its rights
 * its routines do not need.
 *
 * How it reads the rights: with `ct_whoami` through the pipeline with the
 * token of the account, in the mode `operator` and with a line in the
 * audit, like `ecclium policy init --routine`. It judges them with the
 * chain of the write guard: the tools of the routines that start, as the
 * runner hands them to every run, and `accountRightsOf` of the core. So a
 * right only a routine needs that does not start, such as one without its
 * provider, counts as too wide, as it does for the write of a run.
 *
 * What `ct_whoami` cannot give is never read as fine: rights in a form the
 * core does not know, an error, also the one for more than 150 rights,
 * and a list of categories cut short that `accountRightsOf` cannot judge
 * whole.
 *
 * @packageDocumentation
 */
import {
  type AccountRights,
  accountRightsOf,
  createStdioIdentity,
  createStdioTenantResolver,
  type EccliumConfig,
  runnerOwnAlias,
  type ToolCatalog,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import type {
  ErrorCode,
  GrantedRights,
  IsoDate,
  RightValue,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  accountToolsOf,
  type PreparedRun,
  runCredentialOf,
} from '@ecclium/mcp-churchtools-workflows';

import {
  type AccountPipelineCode,
  composeAccountPipeline,
} from '../compose/run-pipeline.js';
import type { Reading } from '../policy/names.js';
import type { RefusedRoutine } from '../runner/start.js';
import { createStdioCatalog } from '../stdio/catalog.js';

/** The right whose list of categories `accountRightsOf` compares. */
const wikiEdit = 'churchwiki\u0000edit category';

/** The rights `ct_whoami` gave, or why there are none. */
export type RightsRead =
  | {
      readonly kind: 'read';
      readonly granted: GrantedRights;
      /** Module and right of each list `ct_whoami` cut short. */
      readonly cut: ReadonlySet<string>;
    }
  /** ChurchTools answered in a form the core does not know. */
  | { readonly kind: 'unknown' }
  /** The call failed, with the code of the pipeline. */
  | { readonly kind: 'failed'; readonly code: ErrorCode }
  /** The token file of the account could not be used. */
  | { readonly kind: 'account'; readonly code: AccountPipelineCode };

/** How the rights of an account came out. */
export type AccountRightsCheck =
  | {
      readonly kind: 'judged';
      readonly rights: AccountRights;
      /**
       * Whether the list of the categories of `edit category` was cut short
       * and `accountRightsOf` found it fine: then it is not judged whole.
       */
      readonly cut: boolean;
    }
  | Exclude<RightsRead, { readonly kind: 'read' }>;

/** What the check found for one account. */
export interface AccountCheck {
  /** The alias of the account, `runner` for the own account. */
  readonly credential: string;
  /** The routines of the account that start, in the order of their IDs. */
  readonly routines: readonly string[];
  /** The routines of the account that do not start. */
  readonly refused: readonly RefusedRoutine[];
  /** The rights, or why they were not judged. */
  readonly rights: AccountRightsCheck;
}

// A field of a plain object of the pipeline, read only when it is its own.
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;

/**
 * Turns the answer of `ct_whoami` back into the rights as the client reads
 * them: a right without IDs is `true`, one with IDs the IDs it lists,
 * which are its lowest ten when `idCount` says it has more.
 *
 * @param data - The data of the answer, as the pipeline gave it.
 * @returns The rights, `unknown` for the status unknown, or undefined for
 *   any other form.
 * @example
 * ```ts
 * grantedOf({ rights: { status: 'known', modules: [{ module: 'churchwiki', rights: [{ right: 'view' }] }] } });
 * ```
 */
export function grantedOf(data: unknown): RightsRead | undefined {
  const rights = field(data, 'rights');
  const status = field(rights, 'status');
  if (status === 'unknown') return Object.freeze({ kind: 'unknown' });
  const modules = field(rights, 'modules');
  if (status !== 'known' || !Array.isArray(modules)) return undefined;
  const granted: [string, Readonly<Record<string, RightValue>>][] = [];
  const cut = new Set<string>();
  for (const entry of modules as readonly unknown[]) {
    const module = field(entry, 'module');
    const list = field(entry, 'rights');
    if (typeof module !== 'string' || !Array.isArray(list)) return undefined;
    const values: [string, RightValue][] = [];
    for (const item of list as readonly unknown[]) {
      const right = field(item, 'right');
      const ids = field(item, 'ids');
      const count = field(item, 'idCount');
      if (typeof right !== 'string') return undefined;
      if (ids === undefined) {
        values.push([right, true]);
        continue;
      }
      if (
        !Array.isArray(ids) ||
        !(ids as readonly unknown[]).every((id) => Number.isSafeInteger(id))
      ) {
        return undefined;
      }
      values.push([right, Object.freeze([...(ids as readonly number[])])]);
      if (typeof count === 'number' && count > ids.length) {
        cut.add(`${module}\u0000${right}`);
      }
    }
    // fromEntries makes own data properties, also for a name such as
    // __proto__.
    granted.push([module, Object.freeze(Object.fromEntries(values))]);
  }
  return Object.freeze({
    kind: 'read',
    granted: Object.freeze(Object.fromEntries(granted)),
    cut,
  });
}

/** What the check of the accounts needs, with replacements for tests. */
export interface AccountsOptions {
  /** The configuration of the runner. */
  readonly config: EccliumConfig;
  /** The catalog of the runner, whose tools the routines name. */
  readonly catalog: Pick<ToolCatalog, 'get'>;
  /** The routines that start, as the runner prepared them. */
  readonly routines: readonly PreparedRun[];
  /** The routines that do not start. */
  readonly refused: readonly RefusedRoutine[];
  /** The audit file, the writer of the logs and the clock. */
  readonly reading: Reading;
  /** The UTC day, for the exceptions of the policy. */
  readonly day: IsoDate;
  /** Replaces the factory of the transport, for tests. */
  readonly createTransport?:
    ((options: HttpTransportOptions) => HttpTransport) | undefined;
}

// Reads the rights of one account with ct_whoami, through a pipeline that
// only reads, with the token of the account and a line in the audit.
const readRights = async (
  options: AccountsOptions,
  credential: string,
): Promise<RightsRead> => {
  const { config, reading } = options;
  // Only the tools that are always there, among them ct_whoami, and none
  // that writes.
  const narrowed: EccliumConfig = Object.freeze({
    ...config,
    toolsets: Object.freeze([]),
    readOnly: true,
  });
  const built = composeAccountPipeline({
    config: narrowed,
    catalog: createStdioCatalog(narrowed),
    writer: reading.writer,
    clock: reading.clock,
    auditFile: reading.auditFile,
    createTransport: options.createTransport,
    credential,
  });
  if (!built.ok) return Object.freeze({ kind: 'account', code: built.code });
  try {
    // The mode is a literal of the command, never taken from the
    // configuration or a request (ADR 0024).
    const request: ToolRequest = Object.freeze({
      assignment: await createStdioTenantResolver().resolve(
        createStdioIdentity(narrowed),
      ),
      mode: 'operator',
      redaction: config.redaction,
      readOnly: true,
      features: Object.freeze([]),
      signal: new AbortController().signal,
    });
    const outcome = await built.pipeline.call('ct_whoami', {}, request);
    if (!outcome.ok) {
      return Object.freeze({ kind: 'failed', code: outcome.error.code });
    }
    return (
      grantedOf(outcome.data) ??
      Object.freeze({ kind: 'failed', code: 'internal' })
    );
  } finally {
    await built.close().catch(() => undefined);
  }
};

// The alias of the account of a routine, as the runner settles it: the
// alias of its entries, or the own account of the runner without one.
const aliasOf = (config: EccliumConfig, routineId: string): string => {
  const settled = runCredentialOf(config.policy, routineId);
  return settled.ok ? (settled.credential ?? runnerOwnAlias) : runnerOwnAlias;
};

/**
 * Checks the own account of the runner and every alias of the policy, in
 * this order, the aliases sorted.
 *
 * @param options - Configuration, catalog, routines, the audit file and
 *   the day.
 * @returns What the check found for each account, frozen.
 * @example
 * ```ts
 * const accounts = await checkAccounts({ config, catalog, routines, refused, reading, day });
 * ```
 */
export async function checkAccounts(
  options: AccountsOptions,
): Promise<readonly AccountCheck[]> {
  const { config, routines, refused, catalog, day } = options;
  const aliases = [
    ...new Set(config.policy.unattended.map((entry) => entry.credential)),
  ]
    .filter((alias) => alias !== runnerOwnAlias)
    .sort();
  const checks: AccountCheck[] = [];
  for (const credential of [runnerOwnAlias, ...aliases]) {
    const read = await readRights(options, credential);
    let rights: AccountRightsCheck;
    if (read.kind === 'read') {
      const judged = accountRightsOf(
        catalog,
        config.policy,
        credential,
        accountToolsOf(routines, credential),
        read.granted,
        day,
      );
      rights =
        judged === undefined
          ? Object.freeze({ kind: 'failed', code: 'internal' })
          : Object.freeze({
              kind: 'judged',
              rights: judged,
              cut:
                read.cut.has(wikiEdit) &&
                !judged.beyond.some(
                  ({ module, right }) => `${module}\u0000${right}` === wikiEdit,
                ),
            });
    } else {
      rights = read;
    }
    checks.push(
      Object.freeze({
        credential,
        routines: Object.freeze(
          routines
            .filter((run) => (run.credential ?? runnerOwnAlias) === credential)
            .map((run) => run.loaded.routine.id)
            .sort(),
        ),
        refused: Object.freeze(
          refused.filter(
            (item) => aliasOf(config, item.routineId) === credential,
          ),
        ),
        rights,
      }),
    );
  }
  return Object.freeze(checks);
}
