// Helpers of tests/scripts/smoke-write.test.mts: starts the stand-in of
// ChurchTools in a process of its own (serve.mts) and prepares what a run
// of the smoke test for writing reads from its environment, in a temporary
// folder outside every Git working tree: the token file with mode 0600,
// the state of 00-inventory with the synthetic OpenAPI document of the
// spike tests, and the paths of the two state files, which must not exist
// yet. Everything is made up at run time (tests/fixtures/README.md).
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createState, instanceId } from '../../../scripts/spike/lib/env.mts';
import type { FetchFunction } from '../../../scripts/spike/lib/http.mts';
import { asOpenApi } from '../../../scripts/spike/lib/spec.mts';
import { specification } from '../../spike/support.mts';
import type { Certificate } from '../../support/certificates.mts';
import { guardPreload } from '../../support/no-network.mts';
import type {
  StandInCall,
  StandInConfig,
  StandInState,
} from './church-tools.mts';

/** The host of the stand-in; redirect.mts sends it to 127.0.0.1. */
export const standInHost = 'demo.example';

/** The switch that fits {@link standInHost}: its first label. */
export const standInSwitch = 'demo';

const serveFile = fileURLToPath(new URL('serve.mts', import.meta.url));

/** A running stand-in. */
export interface StandIn {
  /** `https://demo.example:<port>`, for the smoke test and the server. */
  readonly origin: string;
  /** The fetch of the guard, which reaches the same state on 127.0.0.1. */
  readonly fetch: FetchFunction;
  /** Every request the stand-in answered so far. */
  calls(): Promise<readonly StandInCall[]>;
  /** What it holds now. */
  state(): Promise<StandInState>;
  /** Ends the process. */
  stop(): Promise<void>;
}

/**
 * Makes the IDs and the token of one stand-in, random for each run.
 *
 * @param token - The token of the write account.
 * @param canary - The canary of the test.
 * @param extra - How the stand-in misbehaves.
 * @returns The configuration of the stand-in.
 */
export function standInConfig(
  token: string,
  canary: string,
  extra: Partial<StandInConfig> = {},
): StandInConfig {
  const category = randomInt(10_000, 20_000);
  return {
    token,
    canary,
    account: randomInt(100, 1000),
    other: randomInt(1000, 2000),
    identification: category + randomInt(1, 1000),
    category,
    calendar: randomInt(30_000, 40_000),
    resource: randomInt(40_000, 50_000),
    resourceType: randomInt(50_000, 60_000),
    ...extra,
  };
}

/**
 * Starts the stand-in in a process of its own, with the network guard.
 *
 * @param config - IDs, names and misbehaviour.
 * @param certificate - Key and certificate for {@link standInHost}.
 * @returns The running stand-in.
 */
export async function startStandIn(
  config: StandInConfig,
  certificate: Certificate,
): Promise<StandIn> {
  const child = spawn(process.execPath, [serveFile], {
    env: {
      NODE_OPTIONS: guardPreload,
      STAND_IN_CONFIG: JSON.stringify(config),
      STAND_IN_KEY: certificate.key,
      STAND_IN_CERT: certificate.cert,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  const ports = await new Promise<{ tls: number; plain: number }>(
    (resolve, reject) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          resolve(
            JSON.parse(buffer.slice(0, end)) as { tls: number; plain: number },
          );
        }
      });
      void exited.then(() => {
        reject(new Error(`the stand-in ended early: ${stderr}`));
      });
    },
  );
  const plain = `http://127.0.0.1:${String(ports.plain)}`;
  const control = async (path: string): Promise<unknown> => {
    const response = await fetch(`${plain}${path}`);
    return response.json();
  };
  return {
    origin: `https://${standInHost}:${String(ports.tls)}`,
    fetch: (input, init) =>
      fetch(new URL(`${input.pathname}${input.search}`, plain), init),
    calls: async () => (await control('/__calls')) as readonly StandInCall[],
    state: async () => (await control('/__state')) as StandInState,
    stop: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

/** The files of one run, in a folder of its own. */
export interface RunFiles {
  readonly folder: string;
  /** The temporary folder the smoke test makes its folders in. */
  readonly tmp: string;
  readonly tokenFile: string;
  readonly stateFile: string;
  readonly writeStateFile: string;
  readonly calendarStateFile: string;
}

/**
 * Prepares the files of one run: the token file and the state of
 * 00-inventory for the origin of the stand-in. The state files stay
 * unwritten, as the smoke test asks.
 *
 * @param base - The temporary folder of the test.
 * @param token - The token of the write account.
 * @param origin - The origin of the stand-in, with its port.
 * @returns The paths.
 */
export function prepareRun(
  base: string,
  token: string,
  origin: string,
): RunFiles {
  const folder = mkdtempSync(join(base, 'lauf-'));
  const tmp = join(folder, 'tmp');
  mkdirSync(tmp);
  const tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const stateFile = join(folder, 'state.json');
  const document = asOpenApi(specification);
  if (document === undefined) {
    throw new Error('the synthetic document is not accepted');
  }
  createState(stateFile, {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.138',
    specification: document,
  });
  return {
    folder,
    tmp,
    tokenFile,
    stateFile,
    writeStateFile: join(folder, 'schreib-state.jsonl'),
    calendarStateFile: join(folder, 'kalender-state.jsonl'),
  };
}

/**
 * The environment of a run as an operator sets it, and nothing else: no
 * NODE_OPTIONS, which the smoke test refuses.
 *
 * @param origin - The origin of the stand-in.
 * @param files - The files of the run.
 * @param config - The IDs of the stand-in.
 * @returns The variables.
 */
export function smokeEnv(
  origin: string,
  files: RunFiles,
  config: StandInConfig,
): Record<string, string> {
  return {
    ECCLIUM_SPIKE_BASE_URL: origin,
    ECCLIUM_SPIKE_ALLOW_WRITE: standInSwitch,
    ECCLIUM_SPIKE_WRITE_TOKEN_FILE: files.tokenFile,
    ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
    ECCLIUM_SPIKE_WRITE_CATEGORY_ID: String(config.category),
    ECCLIUM_SPIKE_WRITE_CALENDAR_ID: String(config.calendar),
    ECCLIUM_SPIKE_WRITE_RESOURCE_ID: String(config.resource),
    ECCLIUM_SPIKE_WRITE_STATE_FILE: files.writeStateFile,
    ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE: files.calendarStateFile,
  };
}
