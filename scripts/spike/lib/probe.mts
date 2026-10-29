/**
 * The common course of every probe.
 *
 * A probe first prints the Node.js version and the hashes of the scripts,
 * then checks its environment, fills the block list with everything that
 * could identify the instance or the local machine, and only then sends
 * requests. Whatever goes wrong ends in a fixed code.
 *
 * A probe of the write account also passes the checks of the guard that
 * need no request (ADR 0049), takes its token from its own variable, and
 * gets an opaque handle instead of a write client. Only the guard turns
 * that handle into a client that writes.
 *
 * A probe that reads personal data likewise passes the checks of the guard
 * for personal data that need no request. It gets a client for the two
 * reads of that guard only, and an opaque handle. Only that guard turns
 * the handle into a client that reaches the paths with personal data.
 *
 * A probe that reads the public help pages of ChurchTools also gets a
 * client for the academy. It is a client of its own, without a token, so
 * no way leads from the token to the academy (ADR 0027).
 *
 * @packageDocumentation
 */
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { domainToUnicode, fileURLToPath } from 'node:url';

import { createAcademyClient, type AcademyClient } from './academy.mts';
import {
  checkNewState,
  checkNodeEnvironment,
  readOrigin,
  readState,
  readToken,
  spikeVariables,
  statePath,
  type Environment,
  type SpikeState,
} from './env.mts';
import {
  checkWriteEnvironment,
  createWriteAccess,
  noInput,
  type Input,
  type WriteAccess,
  type WriteSettings,
} from './gate.mts';
import { SpikeError } from './errors.mts';
import { Guard, type Json } from './guard.mts';
import {
  createClient,
  createGateClient,
  type Client,
  type FetchFunction,
} from './http.mts';
import { operations } from './operations.mts';
import {
  checkPersonsEnvironment,
  createPersonsAccess,
  personsGateOperations,
  type PersonsAccess,
  type PersonsSettings,
} from './persons-gate.mts';
import {
  installCrashHandlers,
  integrityLines,
  writeError,
  writeResult,
  type Io,
} from './output.mts';

/** What a probe gets to do its work. */
export interface ProbeContext {
  readonly origin: string;
  /**
   * The client that reads. For a probe that reads personal data it
   * reaches only the two reads of the guard for personal data.
   */
  readonly client: Client;
  readonly guard: Guard;
  readonly env: Environment;
  readonly statePath: string;
  /** The state of 00-inventory, for every probe except 00-inventory. */
  readonly state: SpikeState | undefined;
  /** For a probe of the write account: the handle for the guard. */
  readonly write: WriteSetup | undefined;
  /** For a probe that reads personal data: the handle for its guard. */
  readonly persons: PersonsSetup | undefined;
  /** For a probe that reads the help pages: the client for the academy. */
  readonly academy: AcademyClient | undefined;
  /** Waits, for example between two writes. Replaceable in tests. */
  readonly wait: (milliseconds: number) => Promise<void>;
}

/** What a probe of the write account gets for the guard. */
export interface WriteSetup {
  readonly access: WriteAccess;
  readonly settings: WriteSettings;
}

/** What a probe that reads personal data gets for the guard. */
export interface PersonsSetup {
  readonly access: PersonsAccess;
  readonly settings: PersonsSettings;
}

/** A probe: its name, how it uses the state, and its work. */
export interface ProbeDefinition {
  readonly name: string;
  /** `create` for 00-inventory, `read` for all others. */
  readonly state: 'create' | 'read';
  /** Which account the probe runs with. Default: the read account. */
  readonly account?: 'read' | 'write';
  /** Set for the probes that read persons, groups, search and the domains. */
  readonly personalData?: true;
  /** Set for the probe that also reads the public help pages. */
  readonly academy?: true;
  /** The User-Agent for the academy, if not the one of the probes. */
  readonly academyAgent?: string;
  readonly run: (context: ProbeContext) => Promise<Json>;
}

/** What a probe needs from outside. Replaceable in tests. */
export interface Dependencies {
  readonly env: Environment;
  readonly fetch: FetchFunction;
  readonly io: Io;
  /** Folder of the probes, for the hashes. */
  readonly folder: string;
  /** Where a confirmation comes from. Default: nowhere, so nothing is confirmed. */
  readonly input?: Input;
  /** How a probe waits. Default: a real timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/** The domain of instances hosted by the vendor of ChurchTools. */
const hostedDomain = 'church.tools';

function hostParts(hostname: string): string[] {
  if (hostname.startsWith('[')) {
    // An IPv6 address: the address without brackets and each of its groups.
    const address = hostname.slice(1, -1);
    return [address, ...address.split(':').filter((group) => group !== '')];
  }
  const labels = hostname.split('.');
  // Every instance hosted by the vendor shares the two labels of its
  // domain, so they say nothing about the instance. Blocked, they would
  // withhold right names such as «admin church category» on every such
  // instance. Every other label stays, the top-level domain included,
  // since one like .zuerich narrows down where an instance is.
  return hostname.endsWith(`.${hostedDomain}`) ? labels.slice(0, -2) : labels;
}

/**
 * Lists what the address of an instance puts onto the block list.
 *
 * That is the origin, the host with its port, the port, and the host name
 * with each of its parts, both in the ASCII form of the URL and in its
 * Unicode form, so a name with umlauts is caught in either spelling. An
 * IPv6 address is split into its groups. For an instance under
 * `church.tools` the two labels of that domain are left out.
 *
 * @param origin - Origin of the instance, as read from the environment.
 * @returns The values to block, each once.
 * @example
 * ```ts
 * hostValues('https://example.church.tools');
 * // ['https://example.church.tools', 'example.church.tools', 'example']
 * ```
 */
export function hostValues(origin: string): string[] {
  const url = new URL(origin);
  const values = [origin, url.host];
  if (url.port !== '') {
    values.push(url.port);
  }
  for (const name of [url.hostname, domainToUnicode(url.hostname)]) {
    if (name !== '') {
      values.push(name, ...hostParts(name));
    }
  }
  return [...new Set(values)];
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
  for (const name of spikeVariables) {
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
 * Runs a probe from start to end.
 *
 * @param definition - The probe.
 * @param dependencies - Environment, fetch, output and folder.
 * @returns The exit code.
 */
export async function runProbe(
  definition: ProbeDefinition,
  dependencies: Dependencies,
): Promise<number> {
  const { env, io } = dependencies;
  for (const line of integrityLines(dependencies.folder)) {
    io.stderr(`${line}\n`);
  }
  try {
    checkNodeEnvironment(env);
    const origin = readOrigin(env);
    if (definition.personalData === true && definition.account === 'write') {
      throw new SpikeError('INTERN');
    }
    const settings =
      definition.account === 'write'
        ? checkWriteEnvironment(env, origin)
        : undefined;
    const personsSettings =
      definition.personalData === true
        ? checkPersonsEnvironment(env, origin)
        : undefined;
    const token = readToken(
      env,
      settings === undefined
        ? 'ECCLIUM_SPIKE_TOKEN_FILE'
        : 'ECCLIUM_SPIKE_WRITE_TOKEN_FILE',
    );
    const path = statePath(env);
    const guard = new Guard();
    blockLocal(guard, env, origin, token);
    if (definition.state === 'create') {
      checkNewState(path);
    }
    const state =
      definition.state === 'read' ? readState(path, origin) : undefined;
    if (state !== undefined) {
      // The OpenAPI document in the state describes the API, see the README.
      guard.blockAll({ instance: state.instance, version: state.version });
    }
    const options = { origin, token, guard, fetch: dependencies.fetch };
    const client =
      personsSettings === undefined
        ? createClient(options)
        : createGateClient(
            options,
            personsGateOperations.map((name) => operations[name].template),
          );
    const persons =
      personsSettings === undefined
        ? undefined
        : { access: createPersonsAccess(options), settings: personsSettings };
    const write =
      settings === undefined
        ? undefined
        : {
            access: createWriteAccess(
              { origin, token, guard, fetch: dependencies.fetch },
              dependencies.input ?? noInput,
            ),
            settings,
          };
    const wait =
      dependencies.wait ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    const academy =
      definition.academy === true
        ? createAcademyClient({
            fetch: dependencies.fetch,
            wait,
            ...(definition.academyAgent === undefined
              ? {}
              : { userAgent: definition.academyAgent }),
          })
        : undefined;
    const output = await definition.run({
      origin,
      client,
      guard,
      env,
      statePath: path,
      state,
      write,
      persons,
      academy,
      wait,
    });
    return writeResult(output, guard, io);
  } catch (error) {
    return writeError(error, io);
  }
}

/**
 * Reads one line from the terminal, with the prompt on stderr, so that
 * stdout carries only the result.
 *
 * @param prompt - Fixed text of the probe.
 * @returns The line, or `undefined` at the end of the input.
 */
export function askTerminal(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let answer: string | undefined;
    reader.once('line', (line) => {
      answer = line;
      reader.close();
    });
    reader.once('close', () => {
      resolve(answer);
    });
    reader.setPrompt(prompt);
    reader.prompt();
  });
}

/**
 * Starts a probe as a program, with the real environment.
 *
 * @param definition - The probe.
 * @param moduleUrl - `import.meta.url` of the probe file.
 * @returns The exit code.
 */
export async function main(
  definition: ProbeDefinition,
  moduleUrl: string,
): Promise<number> {
  const io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  installCrashHandlers(io);
  return runProbe(definition, {
    env: process.env,
    fetch,
    io,
    folder: dirname(fileURLToPath(moduleUrl)),
    input: { isTerminal: process.stdin.isTTY, readLine: askTerminal },
  });
}
