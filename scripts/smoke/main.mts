/**
 * The smoke test against a real instance: its course from start to end.
 *
 * It starts the built server over stdio twice, once per era of the
 * protocol, each time with exactly these variables: the address and the
 * token file from the environment, `ECCLIUM_READ_ONLY=true` whatever the
 * shell says, a folder of state of its own in the temporary folder, and
 * the toolsets: `docs` without its switch,
 * `persons,events,calendars,wiki,songs,docs` with it and `api` as well
 * with the second switch. Without the switch it reads from ChurchTools
 * only through `ct_whoami`, so on a productive instance nothing but the
 * account of the server is read; the docs tools read only the docs index
 * of the build. With the switch it first reads
 * the wiki categories itself and goes on only if the account sees exactly
 * one identification category of the test instance, which it may neither
 * edit nor delete (ADR 0049).
 *
 * It writes nothing into ChurchTools. Its folders of state it removes
 * again. Its result is JSON of fixed words, checked by the guard of the
 * spike before it leaves, so neither names nor IDs nor the host nor the
 * search term can reach the output.
 *
 * @packageDocumentation
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { versionOf } from '../spike/00-inventory.mts';
import type { Environment } from '../spike/lib/env.mts';
import { SpikeError, hints, type HintKey } from '../spike/lib/errors.mts';
import { findIdentification, readCategories } from '../spike/lib/gate.mts';
import { Guard, type Json } from '../spike/lib/guard.mts';
import { createGateClient, type FetchFunction } from '../spike/lib/http.mts';
import { operations } from '../spike/lib/operations.mts';
import type { Io } from '../spike/lib/output.mts';
import { hostValues } from '../spike/lib/probe.mts';
import { countClasses } from '../spike/lib/structure.mts';
import { auditFits, auditWords, readAuditLines } from './audit.mts';
import {
  courseCodes,
  courseWords,
  eventSpans,
  runEra,
  type Era,
} from './course.mts';
import { defaultDeadlines, startServer, type Deadlines } from './session.mts';
import { readSmokeSettings, type SmokeSettings } from './settings.mts';

/**
 * Exit codes after the conventions of sysexits, as the command `ecclium`
 * uses them, with 1 for a check that failed.
 */
export const smokeExitCodes = {
  ok: 0,
  failed: 1,
  usage: 64,
  unavailable: 69,
  internal: 70,
  refused: 77,
  configuration: 78,
} as const;

/** How the server starts. */
export interface ServerStart {
  /** Usually Node.js itself. */
  readonly executable: string;
  /** Arguments before the entry, empty in a real run. */
  readonly preArgs: readonly string[];
  /** The entry of the command `ecclium`; it must exist. */
  readonly entry: string;
  /** More variables for the child, only in tests. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What the smoke test needs from outside. Replaceable in tests. */
export interface SmokeDependencies {
  readonly env: Environment;
  readonly args: readonly string[];
  readonly io: Io;
  /** For the reads of the guard. */
  readonly fetch: FetchFunction;
  readonly platform: string;
  /** The temporary folder for the folders of state. */
  readonly tmpdir: string;
  readonly server: ServerStart;
  readonly deadlines?: Deadlines;
  /** Makes the term that matches nothing. */
  readonly missTerm?: () => string;
  /**
   * Learns of each folder of state while it exists, so that the entry can
   * remove it after an interrupt, when no `finally` runs.
   */
  readonly track?: (folder: string, exists: boolean) => void;
}

// A refusal of the guard: the instance counts as productive, or the switch
// does not fit it.
const guardHints: ReadonlySet<HintKey> = new Set<HintKey>([
  'smokeSchalterFehlt',
  'smokeSchalterFalsch',
  'smokeApiSchalterFalsch',
  'smokeWaechterAntwortUnerwartet',
  'smokeKennkategorieFehlt',
  'smokeKennkategorieMehrfach',
  'smokeKennkategorieBearbeitbar',
]);

const exitCodeFor = (error: SpikeError): number => {
  if (error.hint === 'smokeAufruf') return smokeExitCodes.usage;
  if (error.hint !== undefined && guardHints.has(error.hint)) {
    return smokeExitCodes.refused;
  }
  switch (error.code) {
    case 'KONFIGURATION':
    case 'DATEI':
      return smokeExitCodes.configuration;
    case 'INTERN':
      return smokeExitCodes.internal;
    default:
      return smokeExitCodes.unavailable;
  }
};

/**
 * Reports an error with its fixed code and hint only, never its message.
 *
 * @param error - Whatever was thrown.
 * @param io - Where to write.
 * @returns The exit code.
 */
export function writeSmokeError(error: unknown, io: Io): number {
  if (!(error instanceof SpikeError)) {
    io.stderr(`Code: INTERN\n${hints.smokeIntern}\n`);
    return smokeExitCodes.internal;
  }
  const code = exitCodeFor(error);
  const hint =
    error.hint ??
    (code === smokeExitCodes.unavailable ? 'smokeNetz' : 'smokeIntern');
  io.stderr(`Code: ${error.code}\n${hints[hint]}\n`);
  return code;
}

const topWords = [
  'smoketest',
  'ecclium',
  'suchtools',
  'api',
  'churchtools',
  'kennkategorie',
  'gefunden',
  'aeren',
  'befunde',
  'fehler',
  'ergebnis',
  'bestanden',
  'gescheitert',
  'ja',
  'nein',
  'unbekannt',
  'audit',
] as const;

const blockLocal = (guard: Guard, settings: SmokeSettings): void => {
  for (const value of hostValues(settings.origin)) guard.block(value);
  guard.block(settings.token);
  guard.block(settings.tokenFile);
  if (settings.search !== undefined) guard.block(settings.search.query);
  if (settings.search?.songQuery !== undefined) {
    guard.block(settings.search.songQuery);
  }
  try {
    guard.block(userInfo().username);
  } catch {
    // Without a user name there is nothing to block.
  }
  guard.block(homedir());
};

/**
 * Reads the wiki categories and the version with the token of the account,
 * through a client that reaches exactly these two paths, only with GET.
 * There must be exactly one identification category, and the account may
 * neither edit nor delete it; otherwise the instance counts as productive
 * (ADR 0049).
 *
 * @param settings - The settings with the switch.
 * @param guard - Takes every value of the answers onto its block list.
 * @param fetch - For the two reads.
 * @returns The version of ChurchTools as major and minor number, if the instance names it.
 * @throws {SpikeError} If ChurchTools refuses the token, an answer has another form, or the identification category is missing, double or editable.
 */
async function passGuard(
  settings: SmokeSettings,
  guard: Guard,
  fetch: FetchFunction,
): Promise<string | null> {
  const client = createGateClient(
    { origin: settings.origin, token: settings.token, guard, fetch },
    [operations.wikiCategories.template, operations.info.template],
  );
  const answer = await client.get({ path: operations.wikiCategories.template });
  // A refused token is a matter of the configuration, not a sign of a
  // productive instance; every other unexpected answer still is.
  if (answer.status === 401) {
    throw new SpikeError('KONFIGURATION', 'smokeTokenAbgewiesen');
  }
  const { categories } = readCategories(
    answer,
    'smokeWaechterAntwortUnerwartet',
  );
  findIdentification(categories, {
    missing: 'smokeKennkategorieFehlt',
    multiple: 'smokeKennkategorieMehrfach',
    editable: 'smokeKennkategorieBearbeitbar',
  });
  const info = await client.get({ path: operations.info.template });
  return info.status === 200 ? versionOf(info.body) : null;
}

// The toolsets of a run. The docs tools read only the docs index of the
// build, so they come in every run (ADR 0066); the others read ChurchTools
// and come only with the switch, the escape hatch only with the second.
const toolsetsOf = (search: { readonly api: boolean } | undefined): string =>
  search === undefined
    ? 'docs'
    : `persons,events,calendars,wiki,songs,docs${search.api ? ',api' : ''}`;

const makeStateDir = (base: string): string => {
  try {
    // The resolved path: under macOS the temporary folder lies behind a
    // link, and the server takes only a folder it can check (ADR 0028).
    return mkdtempSync(join(realpathSync(base), 'ecclium-smoke-'));
  } catch {
    throw new SpikeError('DATEI', 'smokeZustandsordner');
  }
};

/**
 * Runs the smoke test.
 *
 * @param deps - Environment, output, the start of the server and what tests replace.
 * @returns The exit code, see {@link smokeExitCodes}.
 */
export async function runSmoke(deps: SmokeDependencies): Promise<number> {
  try {
    if (deps.args.length > 0) {
      throw new SpikeError('KONFIGURATION', 'smokeAufruf');
    }
    if (deps.platform === 'win32') {
      throw new SpikeError('KONFIGURATION', 'smokeWindows');
    }
    const settings = readSmokeSettings(deps.env);
    if (!existsSync(deps.server.entry)) {
      throw new SpikeError('KONFIGURATION', 'smokeBuildFehlt');
    }
    const guard = new Guard();
    blockLocal(guard, settings);
    guard.allowFixed(
      ...topWords,
      ...courseWords,
      ...courseCodes,
      ...auditWords,
      ...countClasses,
    );

    const output: Record<string, Json> = {
      smoketest: 'ecclium',
      suchtools: settings.search === undefined ? 'nein' : 'ja',
      api: settings.search?.api === true ? 'ja' : 'nein',
    };
    if (settings.search !== undefined) {
      const version = await passGuard(settings, guard, deps.fetch);
      if (version !== null) guard.allowVersion(version);
      output['churchtools'] = version ?? 'unbekannt';
      output['kennkategorie'] = 'gefunden';
    }

    const search =
      settings.search === undefined
        ? undefined
        : {
            api: settings.search.api,
            query: settings.search.query,
            songQuery: settings.search.songQuery,
            missTerm:
              deps.missTerm?.() ?? `zq${randomBytes(12).toString('hex')}`,
            spans: eventSpans(new Date()),
          };
    const failures = new Set<string>();
    const findings = new Set<string>();
    const eras: Json[] = [];
    const order: readonly Era[] = ['2026', '2025'];
    for (const era of order) {
      const stateDir = makeStateDir(deps.tmpdir);
      deps.track?.(stateDir, true);
      guard.block(stateDir);
      try {
        const env: Record<string, string> = {
          ECCLIUM_CHURCHTOOLS_URL: settings.origin,
          ECCLIUM_CHURCHTOOLS_TOKEN_FILE: settings.tokenFile,
          // Forced, so a variable of the shell cannot let the server
          // register a writing tool (ADR 0055).
          ECCLIUM_READ_ONLY: 'true',
          ECCLIUM_STATE_DIR: stateDir,
          // Named one by one rather than with all, so that a later toolset
          // in all does not join the run unseen.
          ECCLIUM_TOOLSETS: toolsetsOf(search),
          ...deps.server.env,
        };
        const session = startServer(
          {
            executable: deps.server.executable,
            args: [...deps.server.preArgs, deps.server.entry, 'stdio'],
          },
          env,
          deps.deadlines ?? defaultDeadlines,
        );
        let outcome;
        try {
          outcome = await runEra(era, session, search, guard, {
            token: settings.token,
            query: settings.search?.query,
            songQuery: settings.search?.songQuery,
          });
        } finally {
          // After a failure of the course itself the server still runs,
          // with its folder of state about to go.
          session.dispose();
        }
        const banned = [settings.token, ...outcome.seen];
        if (settings.search !== undefined) banned.push(settings.search.query);
        if (settings.search?.songQuery !== undefined) {
          banned.push(settings.search.songQuery);
        }
        const audited = auditFits(
          readAuditLines(stateDir),
          outcome.calls,
          banned,
        );
        eras.push({
          ...outcome.report,
          audit: audited ? 'wie erwartet' : 'abweichend',
        });
        for (const failure of outcome.failures) failures.add(failure);
        if (!audited) failures.add('audit');
        for (const finding of outcome.findings) findings.add(finding);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        deps.track?.(stateDir, false);
      }
    }
    output['aeren'] = eras;
    output['befunde'] = [...findings];
    output['fehler'] = [...failures];
    output['ergebnis'] = failures.size === 0 ? 'bestanden' : 'gescheitert';

    const withheld = guard.check(output);
    if (withheld.length > 0) {
      deps.io.stdout(
        `${JSON.stringify({ zurueckgehalten: true, stellen: withheld }, null, 2)}\n`,
      );
      deps.io.stderr(`${hints.smokeZurueckgehalten}\n`);
      return smokeExitCodes.internal;
    }
    deps.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return failures.size === 0 ? smokeExitCodes.ok : smokeExitCodes.failed;
  } catch (error) {
    return writeSmokeError(error, deps.io);
  }
}
