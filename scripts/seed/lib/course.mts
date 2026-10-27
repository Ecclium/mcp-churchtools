/**
 * The course of the seed, from the command line to the output.
 *
 * Like a probe of the spike, the seed first prints the Node.js version and
 * the SHA-256 of its scripts and of the shared pieces in
 * `scripts/spike/lib/`, then checks its environment, fills the block list
 * with everything that could identify the instance or the local machine,
 * and only then sends requests. It reads the OpenAPI document of the
 * instance itself, as 00-inventory does, and needs no state file. Its guard
 * decides whether it may go on (ADR 0049, ADR 0061). The output is checked
 * like the output of a probe and holds only labels of the data set and
 * fixed words.
 *
 * @packageDocumentation
 */
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { specificationMaxBytes, versionOf } from '../../spike/00-inventory.mts';
import {
  checkNodeEnvironment,
  readOrigin,
  type Environment,
} from '../../spike/lib/env.mts';
import { SpikeError, errorCodes } from '../../spike/lib/errors.mts';
import { noInput, type Input } from '../../spike/lib/gate.mts';
import { Guard } from '../../spike/lib/guard.mts';
import { createGateClient, type FetchFunction } from '../../spike/lib/http.mts';
import { operations, specificationPath } from '../../spike/lib/operations.mts';
import {
  installCrashHandlers,
  integrityLines,
  writeError,
  writeResult,
  type Io,
} from '../../spike/lib/output.mts';
import { askTerminal, hostValues } from '../../spike/lib/probe.mts';
import {
  checkSeedEnvironment,
  createSeedAccess,
  passSeedGate,
  readSeedToken,
  seedVariables,
} from '../../spike/lib/seed-gate.mts';
import { asOpenApi } from '../../spike/lib/spec.mts';
import { checkAll } from './check.mts';
import { createAll } from './create.mts';
import {
  datedData,
  groups,
  pages,
  persons,
  services,
  songs,
  structure,
} from './data.mts';
import { resetAll } from './reset.mts';
import { outcomes, reportKeys, sections, SeedRun } from './run.mts';

/** The commands of the seed. */
export const commands = ['pruefen', 'anlegen', 'zuruecksetzen'] as const;

/** One command of the seed. */
export type Command = (typeof commands)[number];

/** What the seed needs from outside. Replaceable in tests. */
export interface SeedDependencies {
  /** The arguments after the script: exactly one command. */
  readonly args: readonly string[];
  readonly env: Environment;
  readonly fetch: FetchFunction;
  readonly io: Io;
  /** The folder `scripts/` of the repository, for the hashes. */
  readonly scriptsFolder: string;
  /** Where a confirmation comes from. Default: nowhere. */
  readonly input?: Input;
  /** How the seed waits between writes. Default: a real timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** The time of the run. Default: now. */
  readonly now?: () => Date;
}

const summaries: Readonly<Record<Command, string>> = {
  pruefen: '',
  anlegen:
    'Seed: anlegen. Legt die fehlenden Objekte des Datensatzes mit dem Kennzeichen «Seedprobe» an.',
  zuruecksetzen:
    'Seed: zuruecksetzen. Löscht Seiten, Events, Termine, Songs und Buchungen mit dem Kennzeichen «Seedprobe». Struktur, Personen und Gruppen bleiben.',
};

/**
 * Every label of the data set, as the report uses them.
 *
 * @returns The labels, each once.
 */
export function labels(): string[] {
  const data = datedData(new Date(0));
  const words: string[] = [
    ...Object.values(structure).map((item) => item.label),
    ...services.flatMap((spec) => [spec.label, `${spec.label}Mails`]),
    ...persons.map((spec) => spec.label),
    ...groups.flatMap((spec) => [
      spec.label,
      `${spec.label}Seedkonto`,
      ...spec.members.map((person) => `${spec.label}${person}`),
    ]),
    ...songs.flatMap((spec) => [
      spec.label,
      ...spec.arrangements.map((arrangement) => arrangement.label),
    ]),
    ...data.appointments.flatMap((spec) => [
      spec.label,
      ...(spec.event === undefined
        ? []
        : [
            spec.event.label,
            ...spec.event.assignments.flatMap((assignment) => [
              assignment.label,
              `${assignment.label}Zusage`,
            ]),
            ...spec.event.agenda.map((item) => item.label),
          ]),
    ]),
    ...data.bookings.map((spec) => spec.label),
    ...pages.map((spec) => spec.label),
    'diensteOhneMails',
  ];
  return [...new Set(words)];
}

function scriptLines(scriptsFolder: string): string[] {
  const [node, heading, ...seed] = integrityLines(join(scriptsFolder, 'seed'));
  const shared = integrityLines(join(scriptsFolder, 'spike', 'lib')).slice(2);
  return [
    node ?? '',
    heading ?? '',
    ...seed.map((line) => line.replace('  ', '  seed/')),
    ...shared.map((line) => line.replace('  ', '  spike/lib/')),
  ];
}

function parseCommand(args: readonly string[]): Command {
  const [command, ...rest] = args;
  if (
    rest.length > 0 ||
    command === undefined ||
    !(commands as readonly string[]).includes(command)
  ) {
    throw new SpikeError('KONFIGURATION', 'seedBefehl');
  }
  return command as Command;
}

function blockLocal(
  guard: Guard,
  env: Environment,
  origin: string,
  token: string,
): void {
  for (const value of hostValues(origin)) {
    guard.block(value);
  }
  guard.block(token);
  for (const name of seedVariables) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      guard.block(value);
    }
  }
  try {
    guard.block(userInfo().username);
  } catch {
    // Without a user name there is nothing to block.
  }
  guard.block(homedir());
}

/**
 * Runs the seed from start to end.
 *
 * @param dependencies - Arguments, environment, fetch, output and folder.
 * @returns The exit code: 0, 2 for the environment or the guard, 3 for a withheld output, 4 for the network, 70 for an internal error.
 */
export async function runSeed(dependencies: SeedDependencies): Promise<number> {
  const { env, io } = dependencies;
  for (const line of scriptLines(dependencies.scriptsFolder)) {
    io.stderr(`${line}\n`);
  }
  try {
    checkNodeEnvironment(env);
    const command = parseCommand(dependencies.args);
    const origin = readOrigin(env, 'ECCLIUM_SEED_BASE_URL');
    const settings = checkSeedEnvironment(env, origin);
    const token = readSeedToken(env);
    const guard = new Guard();
    blockLocal(guard, env, origin, token);
    guard.allowFixed(
      ...commands,
      ...sections,
      ...outcomes,
      ...reportKeys,
      ...errorCodes,
      ...labels(),
    );
    const options = { origin, token, guard, fetch: dependencies.fetch };
    // The OpenAPI document describes the API of every instance of the same
    // version; its words stay off the block list, as in 00-inventory.
    const documents = createGateClient(options, [
      specificationPath,
      operations.info.template,
    ]);
    const specification = await documents.get({
      path: specificationPath,
      maxBytes: specificationMaxBytes,
      blockValues: false,
    });
    const document =
      specification.status === 200 ? asOpenApi(specification.body) : undefined;
    if (document === undefined) {
      throw new SpikeError('ANTWORT_UNGUELTIG', 'spezifikationUngueltig');
    }
    const info = await documents.get({ path: operations.info.template });
    const version = versionOf(info.body);
    if (version !== null) {
      guard.allowVersion(version);
    }
    const pass = await passSeedGate(
      { document, settings },
      createSeedAccess(options, dependencies.input ?? noInput),
      { write: command !== 'pruefen', summary: summaries[command] },
    );
    const run = new SeedRun({
      client: pass.client,
      writer: pass.writer,
      guard,
      wait:
        dependencies.wait ??
        ((milliseconds) =>
          new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
          })),
    });
    const context = {
      run,
      settings,
      pass,
      now: (dependencies.now ?? (() => new Date()))(),
    };
    if (command === 'pruefen') {
      await checkAll(context);
    } else if (command === 'anlegen') {
      await createAll(context);
    } else {
      await resetAll(context);
    }
    return writeResult(run.output(command, version), guard, io);
  } catch (error) {
    return writeError(error, io);
  }
}

/**
 * Starts the seed as a program, with the real environment.
 *
 * @param moduleUrl - `import.meta.url` of `scripts/seed/seed.mts`.
 * @returns The exit code.
 */
export async function main(moduleUrl: string): Promise<number> {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  installCrashHandlers(io);
  return runSeed({
    args: process.argv.slice(2),
    env: process.env,
    fetch,
    io,
    scriptsFolder: dirname(dirname(fileURLToPath(moduleUrl))),
    input: { isTerminal: process.stdin.isTTY, readLine: askTerminal },
  });
}
