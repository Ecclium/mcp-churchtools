/**
 * The common course of every probe.
 *
 * A probe first prints the Node.js version and the hashes of the scripts,
 * then checks its environment, fills the block list with everything that
 * could identify the instance or the local machine, and only then sends
 * requests. Whatever goes wrong ends in a fixed code.
 *
 * @packageDocumentation
 */
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { domainToUnicode, fileURLToPath } from 'node:url';

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
import { Guard, type Json } from './guard.mts';
import { createClient, type Client, type FetchFunction } from './http.mts';
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
  readonly client: Client;
  readonly guard: Guard;
  readonly env: Environment;
  readonly statePath: string;
  /** The state of 00-inventory, for every probe except 00-inventory. */
  readonly state: SpikeState | undefined;
}

/** A probe: its name, how it uses the state, and its work. */
export interface ProbeDefinition {
  readonly name: string;
  /** `create` for 00-inventory, `read` for all others. */
  readonly state: 'create' | 'read';
  readonly run: (context: ProbeContext) => Promise<Json>;
}

/** What a probe needs from outside. Replaceable in tests. */
export interface Dependencies {
  readonly env: Environment;
  readonly fetch: FetchFunction;
  readonly io: Io;
  /** Folder of the probes, for the hashes. */
  readonly folder: string;
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
    const token = readToken(env);
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
    const client = createClient({
      origin,
      token,
      guard,
      fetch: dependencies.fetch,
    });
    const output = await definition.run({
      origin,
      client,
      guard,
      env,
      statePath: path,
      state,
    });
    return writeResult(output, guard, io);
  } catch (error) {
    return writeError(error, io);
  }
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
  });
}
