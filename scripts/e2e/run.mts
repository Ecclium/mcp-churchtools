// The driver of the E2E job (ADR 0036, ADR 0035, ADR 0052): starts the
// runner after the runner container contract with Docker Compose, beside
// Squid from the template and stand-ins for ChurchTools and a model, and
// checks what only the containers together can show.
//
//   pnpm run e2e        (after pnpm run build)
//
// The proofs, each of which fails the job:
//
// 1. The network: from the network of the runner no direct way to a decoy
//    in the outer network, by name or address; through the proxy only the
//    targets of the list; the runner with an address outside the list ends
//    at its start with 69, and the decoy sees no connection.
// 2. The kill switch: `writes-off` in the read-only /config/stop ends the
//    run with 77 and no request to ChurchTools; without it the same run
//    writes once.
// 3. One section per period: a second run in a new container replaces the
//    section. A copy of the built core with a fault, after which a write
//    never finds its own section, must make this verdict fail.
// 4. The limit per day across two containers on the same /data, and a
//    third container with an empty /data that writes again.
// 5. The contract under Linux: a fresh volume of root stops the start, the
//    handed-over one does not; the daemon ends on docker stop with 143; a
//    folder of the kill switches others may write in stops the start; the
//    peaks of memory and processes of each run stay below the limits.
// 6. `ecclium doctor` from inside the network of the runner.
// 7. The search of the page and the signal, with a policy that allows the
//    whole category: without a stop the run writes once; `docker stop`
//    while ChurchTools holds the list of pages of the search ends the run
//    with 143 at once and without a PATCH; `docker stop` while it holds the
//    PATCH waits for the write, its read after it and its notice. It runs
//    before the rest of 5, so that 5 judges the peak of its run as well.
//
// Everything the containers get is made up here at run time: tokens, keys,
// certificates, the page. The work folder lies outside the repository and
// is removed at the end, also through a container, because files of UID
// 65532 cannot be removed by the user of the job. E2E_KEEP=1 keeps it.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { MockConfig, MockReport } from './mock.mts';
import {
  countCalls,
  highestPeak,
  judgePeaks,
  judgeProbe,
  judgeStopInSearch,
  judgeStopInWrite,
  oneSectionPerPeriod,
  type Peak,
  peakOf,
  peakPrefix,
  type ProbeResult,
  routineId,
  sectionsOf,
  waitBeforeProof,
  withFault,
} from './verdict.mts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const composeFile = join(repo, 'scripts/e2e/compose.yaml');
const squidTemplate = join(repo, 'deploy/selfhost/egress/squid.conf');
const builtCli = join(repo, 'packages/cli/dist/bin.js');
const builtSections = join(repo, 'packages/core/dist/marker/sections.js');
const timeZone = 'Europe/Zurich';
const runnerUid = '65532';
const standInUid = '1000';
// How long a proof may take, so that no change of day falls into it. A
// proof takes seconds; the window keeps the wait before it short, so that
// the job stays within its time near midnight.
const proofWindowMs = 3 * 60_000;
// A mark of this run in the names of volumes and containers, so that what
// an aborted run left behind is never taken for new.
const runMark = randomBytes(3).toString('hex');

const category = { id: 7, name: 'Berichte' } as const;
const pageTitle = 'Wochenbericht';
const allowed = ['churchtools.e2e.test:443', 'model.e2e.test:443'];
// Outside the list: the decoy, and a target of the list on another port.
// The address of the decoy joins them at run time.
const refused = ['decoy.e2e.test:443', 'churchtools.e2e.test:8443'];

/** One proof and what failed in it. */
interface Proof {
  readonly name: string;
  readonly failures: string[];
  ms: number;
}

const proofs: Proof[] = [];
// One entry per measured run, undefined for one that gave no peaks.
const peaks: (Peak | undefined)[] = [];

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// --- Processes ------------------------------------------------------------

/** The variables of Compose, changed per proof for the volumes. */
const composeEnvironment: Record<string, string> = {};

const exec = (
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: 'utf8',
    input: '',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...composeEnvironment, ...environment },
  });

const docker = (args: readonly string[]): SpawnSyncReturns<string> =>
  exec('docker', args);

const compose = (args: readonly string[]): SpawnSyncReturns<string> =>
  exec('docker', ['compose', '-f', composeFile, ...args]);

const must = (
  result: SpawnSyncReturns<string>,
  what: string,
): SpawnSyncReturns<string> => {
  if (result.status !== 0) {
    throw new Error(
      `${what} scheiterte mit ${String(result.status)}: ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join(' | ')}`,
    );
  }
  return result;
};

/** How a container of the runner is started. */
interface RunnerCall {
  /** Variables beside those of the service. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Further mounts, `source:target:ro`. */
  readonly mounts?: readonly string[];
  /** Another program than the runner, such as `node` or `sh`. */
  readonly entrypoint?: string;
  /** Wraps the runner to read the peaks of its cgroup at the end. */
  readonly measure?: boolean;
}

// Runs the runner and writes the peaks of its cgroup last, with `-` for a
// value the kernel does not give. Through sh only for the measure; the
// proof of the signals runs the runner without it.
const measuring = `node /app/packages/cli/dist/bin.js "$@"; code=$?; printf '\\n${peakPrefix} %s %s\\n' "$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo -)" "$(cat /sys/fs/cgroup/pids.peak 2>/dev/null || echo -)"; exit $code`;

const out = (
  work: string,
  name: string,
  result: SpawnSyncReturns<string>,
): void => {
  writeFileSync(join(work, 'out', `${name}.out`), result.stdout);
  writeFileSync(join(work, 'out', `${name}.err`), result.stderr);
};

let callNumber = 0;

const runner = (
  work: string,
  args: readonly string[],
  call: RunnerCall = {},
): SpawnSyncReturns<string> => {
  const options: string[] = ['run', '--rm', '--no-deps', '-T'];
  for (const [name, value] of Object.entries(call.environment ?? {})) {
    options.push('-e', `${name}=${value}`);
  }
  for (const mount of call.mounts ?? []) options.push('-v', mount);
  const command = call.measure
    ? ['--entrypoint', 'sh', 'runner', '-c', measuring, 'sh', ...args]
    : call.entrypoint === undefined
      ? ['runner', ...args]
      : ['--entrypoint', call.entrypoint, 'runner', ...args];
  const result = compose([...options, ...command]);
  callNumber += 1;
  const label = (args[0] ?? 'run').replaceAll(/[^a-z0-9-]+/gu, '-');
  out(work, `${String(callNumber).padStart(2, '0')}-${label}`, result);
  if (call.measure) peaks.push(peakOf(result.stdout));
  return result;
};

// --- Setup ----------------------------------------------------------------

// Finds an openssl that can add a subjectAltName, as the tests do.
const findOpenssl = (): string => {
  for (const candidate of [
    'openssl',
    '/opt/homebrew/bin/openssl',
    '/usr/local/bin/openssl',
    '/usr/bin/openssl',
  ]) {
    const help = spawnSync(candidate, ['req', '-help'], { encoding: 'utf8' });
    if (`${help.stdout}${help.stderr}`.includes('-addext')) return candidate;
  }
  throw new Error('Kein openssl mit -addext gefunden.');
};

/**
 * Reads the image of Node.js from compose.yaml, its one source.
 *
 * @param compose - The text of scripts/e2e/compose.yaml.
 * @returns The image with its digest.
 * @throws {Error} When the file names none.
 */
export const nodeImageOf = (compose: string): string => {
  const image = /^x-node-image: &node-image (\S+)$/mu.exec(compose)?.[1];
  if (image === undefined)
    throw new Error('compose.yaml nennt kein Image für Node.js.');
  return image;
};

/**
 * Reads the image of Squid from the header of the template, its one source.
 *
 * @param template - The text of deploy/selfhost/egress/squid.conf.
 * @returns The image with its digest.
 * @throws {Error} When the header names none with a digest.
 */
export const squidImageOf = (template: string): string => {
  const image = /^# Image: (\S+@sha256:[0-9a-f]{64})$/mu.exec(template)?.[1];
  if (image === undefined)
    throw new Error('Die Vorlage von Squid nennt kein Image mit Digest.');
  return image;
};

/**
 * Reads the limits of the runner from compose.yaml, their one source.
 *
 * @param compose - The text of scripts/e2e/compose.yaml.
 * @returns The memory in bytes and the number of processes.
 * @throws {Error} When the file names no limits.
 */
export const limitsOf = (compose: string): { memory: number; pids: number } => {
  const pids = /^ {4}pids_limit: (\d+)$/mu.exec(compose)?.[1];
  const memory = /^ {4}mem_limit: (\d+)m$/mu.exec(compose)?.[1];
  if (pids === undefined || memory === undefined) {
    throw new Error('compose.yaml nennt keine Grenzen für den Runner.');
  }
  return { memory: Number(memory) * 1024 * 1024, pids: Number(pids) };
};

const pull = async (image: string): Promise<void> => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (docker(['pull', '-q', image]).status === 0) return;
    await sleep(attempt * 10_000);
  }
  throw new Error(`Das Image ${image} liess sich nicht laden.`);
};

const placeholder = (prefix: string): string =>
  `${prefix}-${randomBytes(16).toString('hex')}`;

const routineYaml = `schema: routine.v1
id: ${routineId}
schedule: '0 6 1 1 *'
inputs:
  - name: seiten
    tool: ct_wiki_pages_list
    params: { categoryId: ${String(category.id)} }
    maxItems: 25
generate:
  prompt: prompts/${routineId}.md
  model: default
  output:
    blocks:
      punkte:
        maxItems: 3
        fields:
          text: { type: text, maxLength: 80 }
template: templates/${routineId}.md
output:
  target: wiki
  tool: ct_wiki_page_append_section
  scope: { category: ${category.name}, page: ${pageTitle} }
  idempotencyKey: '${routineId}:{isoWeek}'
notify:
  - channel: stdout
`;

// The page by its GUID, or the whole category, whose page a run finds by
// its title (ADR 0036).
const pageTarget = (guid: string): string =>
  `{ kind: wiki_page, categoryId: ${String(category.id)}, guid: ${guid}, name: ${pageTitle} }`;
const categoryTarget = `{ kind: wiki_category, id: ${String(category.id)}, name: ${category.name} }`;

const policyYaml = (
  target: string,
  maxPerDay: number,
): string => `schema: policy.v1
interactive:
  inquiriesTo: Sekretariat
unattended:
  - routine: ${routineId}
    credential: berichte
    target: ${target}
    tools: [ct_wiki_page_append_section]
    maxPerRun: 1
    maxPerDay: ${String(maxPerDay)}
`;

const providersYaml = `schema: providers.v1
providers:
  - alias: default
    vendor: example
    model: example-model-1
    hostingCountry: CH
    endpoint: https://model.e2e.test/v1/chat/completions
    structuredOutput: true
    apiKeyFile: /run/secrets/model_api_key
`;

// Lays out the work folder and hands it to the users of the containers.
const prepare = (work: string, image: string): void => {
  const openssl = findOpenssl();
  for (const folder of ['out', 'tls', 'egress', 'fault', 'secrets']) {
    mkdirSync(join(work, folder), { mode: 0o755 });
  }
  // Certificates: one key and a self-signed certificate per stand-in,
  // trusted together through ca.pem.
  const pems: string[] = [];
  for (const role of ['churchtools', 'model', 'decoy']) {
    const host = `${role}.e2e.test`;
    must(
      exec(openssl, [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
        '-keyout',
        join(work, 'tls', `${role}.key`),
        '-out',
        join(work, 'tls', `${role}.crt`),
      ]),
      `Das Zertifikat für ${role}`,
    );
    chmodSync(join(work, 'tls', `${role}.key`), 0o644);
    pems.push(readFileSync(join(work, 'tls', `${role}.crt`), 'utf8'));
  }
  writeFileSync(join(work, 'tls', 'ca.pem'), pems.join(''), { mode: 0o644 });

  const guid = randomUUID();
  const runnerToken = placeholder('e2e-runner');
  const reportsToken = placeholder('e2e-berichte');
  const modelKey = placeholder('e2e-model');
  const mock: MockConfig = {
    churchtools: {
      accounts: [
        // The account of the runner itself reads nothing here.
        { token: runnerToken, id: 101, rights: {} },
        // The account of the routine: exactly what its tools need.
        {
          token: reportsToken,
          id: 102,
          rights: {
            churchwiki: {
              view: true,
              'view category': [category.id],
              'edit category': [category.id],
            },
          },
        },
      ],
      category,
      page: { guid, title: pageTitle, text: 'Berichte der Routine.' },
    },
    model: { key: modelKey, block: 'punkte', field: 'text' },
  };
  writeFileSync(join(work, 'mock.json'), JSON.stringify(mock), { mode: 0o644 });

  const config = join(work, 'config');
  mkdirSync(join(config, 'routines', 'prompts'), {
    recursive: true,
    mode: 0o755,
  });
  mkdirSync(join(config, 'routines', 'templates'), { mode: 0o755 });
  // The folder of the kill switches belongs to the operator, here the user
  // of the job, with 755 (ADR 0036).
  mkdirSync(join(config, 'stop'), { mode: 0o755 });
  writeFileSync(join(config, 'policy.yaml'), policyYaml(pageTarget(guid), 5), {
    mode: 0o644,
  });
  writeFileSync(
    join(config, 'policy-limit.yaml'),
    policyYaml(pageTarget(guid), 1),
    { mode: 0o644 },
  );
  writeFileSync(
    join(config, 'policy-category.yaml'),
    policyYaml(categoryTarget, 5),
    { mode: 0o644 },
  );
  writeFileSync(join(config, 'providers.yaml'), providersYaml, { mode: 0o644 });
  writeFileSync(join(config, 'routines', `${routineId}.yaml`), routineYaml, {
    mode: 0o644,
  });
  writeFileSync(
    join(config, 'routines', 'prompts', `${routineId}.md`),
    'Fasse die Seiten in kurzen Punkten zusammen.\n',
    { mode: 0o644 },
  );
  writeFileSync(
    join(config, 'routines', 'templates', `${routineId}.md`),
    '{{#punkte}}\n- {{text}}\n{{/punkte}}\n',
    { mode: 0o644 },
  );

  const secrets = join(work, 'secrets');
  const key = (): string => `${randomBytes(32).toString('hex')}\n`;
  writeFileSync(join(secrets, 'ct_token_runner'), `${runnerToken}\n`, {
    mode: 0o644,
  });
  writeFileSync(join(secrets, 'ct_token_berichte'), `${reportsToken}\n`, {
    mode: 0o644,
  });
  writeFileSync(join(secrets, 'model_api_key'), `${modelKey}\n`, {
    mode: 0o644,
  });
  writeFileSync(join(secrets, 'pseudonym_key'), key(), { mode: 0o644 });
  writeFileSync(join(secrets, 'runner_mac_key'), key(), { mode: 0o644 });

  // Hand over as root without network and with CHOWN and FOWNER only, as
  // fix-perms of the bundle does. Without DAC_OVERRIDE root cannot enter a
  // folder with 700 of another user, so everything is open first, then
  // changes hands, then closes from the bottom up. stop stays the
  // operator's.
  must(
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--cap-add',
      'FOWNER',
      '-v',
      `${config}:/v/config`,
      '-v',
      `${secrets}:/v/secrets`,
      '-v',
      `${join(work, 'tls')}:/v/tls`,
      '-v',
      `${join(work, 'mock.json')}:/v/mock.json`,
      image,
      'sh',
      '-c',
      [
        `find /v/config -path /v/config/stop -prune -o -exec chown ${runnerUid}:${runnerUid} {} +`,
        `chown -R ${runnerUid}:${runnerUid} /v/secrets`,
        'chmod 400 /v/secrets/*',
        'chmod 700 /v/secrets',
        `chown ${standInUid}:${standInUid} /v/tls/churchtools.key /v/tls/model.key /v/tls/decoy.key /v/mock.json`,
        'chmod 400 /v/tls/churchtools.key /v/tls/model.key /v/tls/decoy.key /v/mock.json',
      ].join(' && '),
    ]),
    'Die Übergabe der Ordner',
  );
};

// Makes a fresh pair of volumes for /data and /keys and uses them.
const freshVolumes = (
  label: string,
  image: string,
  handOver: boolean,
): void => {
  const data = `ecclium-e2e-${runMark}-data-${label}`;
  const keys = `ecclium-e2e-${runMark}-keys-${label}`;
  for (const volume of [data, keys]) {
    must(docker(['volume', 'create', volume]), `Das Volume ${volume}`);
    volumes.push(volume);
  }
  if (handOver) handOverVolumes(data, keys, image);
  composeEnvironment['E2E_DATA'] = data;
  composeEnvironment['E2E_KEYS'] = keys;
};

const volumes: string[] = [];

const handOverVolumes = (data: string, keys: string, image: string): void => {
  must(
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--cap-add',
      'FOWNER',
      '-v',
      `${data}:/v/data`,
      '-v',
      `${keys}:/v/keys`,
      image,
      'sh',
      '-c',
      `chmod 700 /v/data /v/keys && chown ${runnerUid}:${runnerUid} /v/data /v/keys`,
    ]),
    'Die Übergabe der Volumes',
  );
};

// --- Stand-ins ------------------------------------------------------------

const reportOf = (
  service: string,
  method = 'GET',
  path = '/',
): MockReport | undefined => {
  const result = compose([
    'exec',
    '-T',
    service,
    'node',
    '-e',
    `fetch('http://127.0.0.1:8081${path}', { method: '${method}' }).then((r) => r.text()).then((t) => process.stdout.write(t))`,
  ]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as MockReport;
  } catch {
    return undefined;
  }
};

const waitFor = async (what: string, ready: () => boolean): Promise<void> => {
  for (let second = 0; second < 60; second += 1) {
    if (ready()) return;
    await sleep(1000);
  }
  throw new Error(`${what} wurde nicht bereit.`);
};

const standIns = ['churchtools', 'model', 'decoy'] as const;

const startServices = async (): Promise<void> => {
  must(compose(['up', '-d', 'egress', ...standIns]), 'Der Start der Dienste');
  await waitFor('Squid', () =>
    compose(['logs', 'egress']).stdout.includes('Accepting HTTP'),
  );
  for (const service of standIns) {
    await waitFor(service, () => reportOf(service) !== undefined);
  }
};

/**
 * Sets the stand-ins back, so that they forget every request and the page.
 * Not by a restart: a new container could get another address, and Squid
 * would still send a tunnel to the old one.
 */
const resetStandIns = async (): Promise<void> => {
  for (const service of standIns) {
    await waitFor(service, () => {
      const report = reportOf(service, 'POST', '/reset');
      return report !== undefined && report.calls.length === 0;
    });
  }
};

// --- Proofs ---------------------------------------------------------------

// Runs a proof after waiting, if need be, until no change of day falls
// into its window. A proof that goes on the state of the one before passes
// 0 and lets the one before wait for both.
const proof = async (
  name: string,
  body: (failures: string[]) => Promise<void> | void,
  windowMs = proofWindowMs,
): Promise<void> => {
  const wait =
    windowMs === 0 ? 0 : waitBeforeProof(Date.now(), windowMs, timeZone);
  if (wait > 0) {
    say(
      `Warte ${String(Math.ceil(wait / 1000))} s, bis der Wechsel des Tages vorbei ist.`,
    );
    await sleep(wait);
  }
  const started = Date.now();
  const failures: string[] = [];
  try {
    await body(failures);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  proofs.push({ name, failures, ms: Date.now() - started });
  say(`${failures.length === 0 ? 'OK    ' : 'FEHLER'} ${name}`);
  for (const failure of failures) say(`       ${failure}`);
};

const expectCode = (
  failures: string[],
  what: string,
  result: SpawnSyncReturns<string>,
  code: number,
): void => {
  if (result.status !== code) {
    failures.push(
      `${what}: Exit ${String(result.status)} statt ${String(code)}${warningsOf(result.stderr)}.`,
    );
  }
};

// The events and codes of the warnings and errors in a log, to show why a
// run ended otherwise; never their other fields.
const warningsOf = (log: string): string => {
  const found: string[] = [];
  for (const line of log.split('\n')) {
    try {
      const entry = JSON.parse(line) as {
        level?: unknown;
        event?: unknown;
        code?: unknown;
      };
      if (entry.level === 'warn' || entry.level === 'error') {
        found.push(
          `${String(entry.event)}${typeof entry.code === 'string' ? `:${entry.code}` : ''}`,
        );
      }
    } catch {
      // Not a line of the logger.
    }
  }
  return found.length === 0 ? '' : ` (${found.slice(-4).join(', ')})`;
};

// What the contract asks of the container, as Docker set it up and as the
// process inside sees it: a read-only file system, no capability, no new
// privileges, the user, the init and the limits (ADR 0036).
const hardeningOf = (
  name: string,
  limits: { readonly memory: number; readonly pids: number },
): string[] => {
  const failures: string[] = [];
  let host: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    PidsLimit?: number | null;
    Memory?: number;
    Init?: boolean | null;
    Privileged?: boolean;
    Tmpfs?: Record<string, string> | null;
  } = {};
  try {
    host = JSON.parse(
      docker(['inspect', '-f', '{{json .HostConfig}}', name]).stdout,
    ) as typeof host;
  } catch {
    return ['docker inspect gab keine Einstellungen des Containers.'];
  }
  const user = docker([
    'inspect',
    '-f',
    '{{.Config.User}}',
    name,
  ]).stdout.trim();
  if (host.ReadonlyRootfs !== true)
    failures.push('Das Dateisystem ist nicht nur lesbar.');
  if (!(host.CapDrop ?? []).includes('ALL'))
    failures.push('Nicht alle Capabilities sind entzogen.');
  if ((host.CapAdd ?? []).length > 0)
    failures.push('Der Container bekommt Capabilities.');
  if (host.Privileged === true)
    failures.push('Der Container ist privilegiert.');
  if (!(host.SecurityOpt ?? []).includes('no-new-privileges:true')) {
    failures.push('no-new-privileges fehlt.');
  }
  if (host.Init !== true) failures.push('Der Container startet ohne init.');
  if (host.PidsLimit !== limits.pids)
    failures.push('Die Grenze für Prozesse fehlt oder weicht ab.');
  if (host.Memory !== limits.memory)
    failures.push('Die Grenze für den Speicher fehlt oder weicht ab.');
  if (!Object.keys(host.Tmpfs ?? {}).includes('/tmp'))
    failures.push('/tmp ist kein tmpfs.');
  if (user !== `${runnerUid}:${runnerUid}`)
    failures.push(`Der Container läuft als ${user}.`);
  // From inside: no effective capability, no new privileges, and neither
  // the root of the file system nor the build can be written.
  const inside = docker([
    'exec',
    name,
    'sh',
    '-c',
    'grep -E "^(CapEff|NoNewPrivs):" /proc/1/status; touch /e2e-probe 2>&1; touch /app/e2e-probe 2>&1; true',
  ]).stdout;
  if (!/^CapEff:\s+0+$/mu.test(inside))
    failures.push('Der Prozess hat Capabilities.');
  if (!/^NoNewPrivs:\s+1$/mu.test(inside))
    failures.push('Der Prozess darf neue Rechte bekommen.');
  if ((inside.match(/Read-only file system/gu) ?? []).length !== 2) {
    failures.push(
      'Der Container kann ausserhalb von /data, /keys und /tmp schreiben.',
    );
  }
  return failures;
};

const patches = (service: string): number =>
  countCalls(reportOf(service)?.calls ?? [], 'PATCH', '/api/wiki/');

// How long ChurchTools holds the list of the search and the PATCH of the
// write, below the 15 seconds Ecclium waits for the head of an answer, so
// that a search that does not stop gets its answer and goes on to write.
const searchHoldMs = 12_000;
const writeHoldMs = 8_000;

// Has ChurchTools hold the nth request of a method below a path.
const holdAt = (method: string, path: string, nth: number, ms: number) => {
  const query = new URLSearchParams({
    method,
    path,
    nth: String(nth),
    ms: String(ms),
  });
  if (
    reportOf('churchtools', 'POST', `/hold?${query.toString()}`) === undefined
  )
    throw new Error('ChurchTools nahm das Halten nicht an.');
};

// Starts run-once in a container of its own, waits until ChurchTools has
// the request it holds, stops the container as a supervisor does and
// tells how the run ended.
const stopWhileHeld = async (
  work: string,
  label: string,
  environment: Record<string, string>,
  held: (report: MockReport) => boolean,
) => {
  const name = `ecclium-e2e-${runMark}-${label}`;
  const options = ['run', '-d', '--no-deps', '--name', name];
  for (const [key, value] of Object.entries(environment)) {
    options.push('-e', `${key}=${value}`);
  }
  must(
    compose([...options, 'runner', 'run-once', routineId]),
    `Der Start von ${label}`,
  );
  try {
    await waitFor(`Die gehaltene Anfrage (${label})`, () => {
      const seen = reportOf('churchtools');
      return seen !== undefined && held(seen);
    });
    const modelCalls = reportOf('model')?.calls.length ?? 0;
    const before = Date.now();
    docker(['stop', '--time', '300', name]);
    const tookMs = Date.now() - before;
    const code = Number(
      docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim(),
    );
    say(
      `       docker stop (${label}): ${(tookMs / 1000).toFixed(1)} s, Exit ${String(code)}`,
    );
    const logs = docker(['logs', name]);
    out(work, `stop-${label}`, logs);
    return {
      code,
      tookMs,
      log: `${logs.stdout}${logs.stderr}`,
      calls: reportOf('churchtools')?.calls ?? [],
      modelCalls,
    };
  } finally {
    docker(['rm', '-f', name]);
  }
};

const pageText = (): string => reportOf('churchtools')?.page?.text ?? '';

// The text of a built file, or undefined without a build. Read once, so
// that no check stands apart from the read.
const builtText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const main = async (): Promise<number> => {
  const sectionsSource = builtText(builtSections);
  if (builtText(builtCli) === undefined || sectionsSource === undefined) {
    say('Der gebaute Stand fehlt. Führen Sie zuerst «pnpm run build» aus.');
    return 1;
  }
  const composeText = readFileSync(composeFile, 'utf8');
  const nodeImage = nodeImageOf(composeText);
  const squidImage = squidImageOf(readFileSync(squidTemplate, 'utf8'));
  const limits = limitsOf(composeText);
  const work = mkdtempSync(
    join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'ecclium-e2e-'),
  );
  composeEnvironment['E2E_WORK'] = work;
  composeEnvironment['E2E_SQUID_IMAGE'] = squidImage;
  // Volumes of no run yet, so that Compose can read the file to take down
  // what an aborted run left of the project.
  composeEnvironment['E2E_DATA'] = `ecclium-e2e-${runMark}-none`;
  composeEnvironment['E2E_KEYS'] = `ecclium-e2e-${runMark}-none`;
  compose(['down', '--remove-orphans', '--timeout', '5']);
  say(
    `Docker ${docker(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']).stdout.trim()}, Compose ${docker(['compose', 'version', '--short']).stdout.trim()}`,
  );
  if (process.platform === 'darwin') {
    // Docker Desktop and OrbStack show a folder of the Mac to every user as
    // his own and pass on a change of it late, so the kill switch and the
    // owners behave otherwise. The run under Linux counts.
    say(
      'Hinweis: Unter macOS bilden eingebundene Ordner Besitzer und Änderungen anders ab als Linux. Massgebend ist der Lauf unter Linux.',
    );
  }
  try {
    await pull(nodeImage);
    await pull(squidImage);
    prepare(work, nodeImage);

    // 5a, the start: a fresh volume belongs to root and stops the runner,
    // the handed-over one does not.
    freshVolumes('start', nodeImage, false);
    await proof(
      'Vertrag: ein frisches Volume von root hält den Start an, ein übergebenes nicht',
      (failures) => {
        expectCode(
          failures,
          'config check --runner mit frischem /data',
          runner(work, ['config', 'check', '--runner']),
          78,
        );
        handOverVolumes(
          composeEnvironment['E2E_DATA'] ?? '',
          composeEnvironment['E2E_KEYS'] ?? '',
          nodeImage,
        );
        expectCode(
          failures,
          'config check --runner nach der Übergabe',
          runner(work, ['config', 'check', '--runner']),
          0,
        );
      },
    );

    // The list of Squid, from the configuration of the runner.
    const list = runner(work, ['init', 'egress']);
    must(list, 'ecclium init egress');
    writeFileSync(join(work, 'egress', 'ecclium-targets.conf'), list.stdout, {
      mode: 0o644,
    });
    await startServices();

    // 1. The network.
    await proof(
      'Grenze im Netz: kein direkter Weg, durch den Proxy nur die Liste',
      (failures) => {
        for (const network of ['runner-int', 'egress-ext']) {
          const internal = docker([
            'network',
            'inspect',
            '-f',
            '{{.Internal}}',
            `ecclium-e2e_${network}`,
          ]).stdout.trim();
          if (internal !== 'true')
            failures.push(`Das Netz ${network} ist nicht intern.`);
        }
        const decoy = compose(['ps', '-q', 'decoy']).stdout.trim();
        const address = docker([
          'inspect',
          '-f',
          '{{(index .NetworkSettings.Networks "ecclium-e2e_egress-ext").IPAddress}}',
          decoy,
        ]).stdout.trim();
        // The decoy by its address joins the targets outside the list.
        const outsideList = [...refused, `${address}:443`];
        const probe = runner(
          work,
          ['/app/scripts/e2e/probe.mts', address, ...allowed, ...outsideList],
          { entrypoint: 'node' },
        );
        let result: ProbeResult | undefined;
        try {
          result = JSON.parse(probe.stdout) as ProbeResult;
        } catch {
          failures.push(
            `Die Probe des Netzes gab kein Ergebnis (Exit ${String(probe.status)}).`,
          );
        }
        if (result !== undefined)
          failures.push(...judgeProbe(result, allowed, outsideList));
        const outside = runner(work, ['run-once', routineId], {
          measure: true,
          environment: {
            ECCLIUM_CHURCHTOOLS_URL: 'https://decoy.e2e.test',
            ECCLIUM_EGRESS_ALLOW_LAN: 'model.e2e.test:443',
          },
        });
        expectCode(
          failures,
          'run-once mit ChurchTools ausserhalb der Liste',
          outside,
          69,
        );
        const seen = reportOf('decoy');
        if (seen === undefined)
          failures.push('Das Lockziel gab keinen Bericht.');
        else if (seen.connections !== 0) {
          failures.push(
            `Das Lockziel sah ${String(seen.connections)} Verbindungen.`,
          );
        }
      },
    );

    // 2. and 3. on the same /data.
    freshVolumes('write', nodeImage, true);
    await resetStandIns();
    const stop = join(work, 'config', 'stop');
    await proof(
      'Kill-Switch: writes-off hält den Lauf mit 77 an, ohne ihn schreibt er einmal',
      (failures) => {
        writeFileSync(join(stop, 'writes-off'), '', { mode: 0o644 });
        expectCode(
          failures,
          'run-once mit writes-off',
          runner(work, ['run-once', routineId], { measure: true }),
          77,
        );
        const asked = reportOf('churchtools')?.calls.length;
        if (asked !== 0)
          failures.push(
            `ChurchTools sah mit dem Kill-Switch ${String(asked)} Anfragen.`,
          );
        if ((reportOf('model')?.calls.length ?? -1) !== 0)
          failures.push('Das Modell sah mit dem Kill-Switch eine Anfrage.');
        unlinkSync(join(stop, 'writes-off'));
        expectCode(
          failures,
          'run-once ohne Kill-Switch',
          runner(work, ['run-once', routineId], { measure: true }),
          0,
        );
        const written = patches('churchtools');
        if (written !== 1)
          failures.push(
            `Ohne Kill-Switch ${String(written)} PATCH statt einem.`,
          );
        failures.push(...oneSectionPerPeriod(pageText(), routineId));
      },
      // The next proof goes on this /data and page, so the window covers
      // both.
      2 * proofWindowMs,
    );

    await proof(
      'Ein Abschnitt je Periode, und der eingebaute Doppelschreib-Fehler fällt auf',
      (failures) => {
        expectCode(
          failures,
          'zweiter Lauf derselben Periode',
          runner(work, ['run-once', routineId], { measure: true }),
          0,
        );
        // The model answers each call with another text, so the second run
        // must write and replace the section, not skip it as a repeat.
        const replaced = patches('churchtools');
        if (replaced !== 2) {
          failures.push(
            `Nach dem zweiten Lauf ${String(replaced)} PATCH statt zweien; er hat den Abschnitt nicht ersetzt.`,
          );
        }
        const replacedText = pageText();
        failures.push(...oneSectionPerPeriod(replacedText, routineId));
        // The first run wrote «Eintrag 1», the second «Eintrag 2».
        if (
          !replacedText.includes('Eintrag 2') ||
          replacedText.includes('Eintrag 1')
        ) {
          failures.push(
            'Nach dem zweiten Lauf steht nicht genau der neue Text auf der Seite.',
          );
        }
        const faulty = withFault(sectionsSource);
        if (!faulty.ok) {
          failures.push(
            `Der Anker des Fehlers steht ${String(faulty.found)}-mal im gebauten Stand statt einmal; die Gegenprobe ist nachzuführen.`,
          );
          return;
        }
        const fault = join(work, 'fault', 'sections.js');
        writeFileSync(fault, faulty.source, { mode: 0o644 });
        const run = runner(work, ['run-once', routineId], {
          measure: true,
          mounts: [`${fault}:/app/packages/core/dist/marker/sections.js:ro`],
        });
        expectCode(failures, 'Lauf mit dem eingebauten Fehler', run, 0);
        // Only a second section of a period counts as found, not an empty
        // page from a report that failed.
        const faultyText = pageText();
        const twice = [...sectionsOf(faultyText, routineId).values()].some(
          (count) => count >= 2,
        );
        if (!twice || oneSectionPerPeriod(faultyText, routineId).length === 0) {
          failures.push(
            'Mit dem eingebauten Fehler steht keine Periode zweimal auf der Seite; die Prüfung wäre blind.',
          );
        }
      },
      0,
    );

    // 4. The limit per day.
    freshVolumes('limit', nodeImage, true);
    await resetStandIns();
    await proof(
      'Tagesgrenze über zwei Container, und ein Container mit leerem /data schreibt wieder',
      (failures) => {
        const limit = { ECCLIUM_POLICY_FILE: '/config/policy-limit.yaml' };
        expectCode(
          failures,
          'erster Container',
          runner(work, ['run-once', routineId], {
            measure: true,
            environment: limit,
          }),
          0,
        );
        expectCode(
          failures,
          'zweiter Container',
          runner(work, ['run-once', routineId], {
            measure: true,
            environment: limit,
          }),
          0,
        );
        const written = patches('churchtools');
        if (written !== 1)
          failures.push(
            `Zwei Container schrieben ${String(written)}-mal statt einmal.`,
          );
        const queued = runner(work, ['-c', 'ls -1 /data/queue | wc -l'], {
          entrypoint: 'sh',
        }).stdout.trim();
        if (!/^[1-9]\d*$/u.test(queued))
          failures.push(
            'Der zweite Container reihte nichts in die Warteschlange.',
          );
        freshVolumes('empty', nodeImage, true);
        expectCode(
          failures,
          'dritter Container mit leerem /data',
          runner(work, ['run-once', routineId], {
            measure: true,
            environment: limit,
          }),
          0,
        );
        const again = patches('churchtools');
        if (again !== 2)
          failures.push(
            `Mit leerem /data ${String(again - written)} PATCH statt einem; die Grenze hinge dann nicht an /data/quota.`,
          );
      },
    );

    // 7. The search of the page and the signal, before the rest of 5.
    freshVolumes('search', nodeImage, true);
    await resetStandIns();
    await proof(
      'Suche der Seite: ein Signal bricht sie ab, einen Schreibvorgang nicht',
      async (failures) => {
        const whole = { ECCLIUM_POLICY_FILE: '/config/policy-category.yaml' };
        // Without a stop, the run finds its page by its title and writes.
        expectCode(
          failures,
          'run-once mit der ganzen Kategorie',
          runner(work, ['run-once', routineId], {
            measure: true,
            environment: whole,
          }),
          0,
        );
        const written = patches('churchtools');
        if (written !== 1)
          failures.push(
            `Mit der ganzen Kategorie ${String(written)} PATCH statt einem.`,
          );
        failures.push(...oneSectionPerPeriod(pageText(), routineId));
        // The second list of pages comes after the model: the search.
        await resetStandIns();
        holdAt('GET', '/api/wiki/pages', 2, searchHoldMs);
        failures.push(
          ...judgeStopInSearch(
            await stopWhileHeld(
              work,
              'search',
              whole,
              (seen) => countCalls(seen.arrived, 'GET', '/api/wiki/pages') >= 2,
            ),
            searchHoldMs,
          ),
        );
        await resetStandIns();
        holdAt('PATCH', '/api/wiki/categories/', 1, writeHoldMs);
        failures.push(
          ...judgeStopInWrite(
            await stopWhileHeld(
              work,
              'write',
              whole,
              (seen) =>
                countCalls(seen.arrived, 'PATCH', '/api/wiki/categories/') >= 1,
            ),
          ),
        );
      },
    );

    // 5b. The rest of the contract.
    freshVolumes('contract', nodeImage, true);
    await proof(
      'Vertrag: Ordner der Kill-Switches, Härtung des Containers, Signal und Grenzen',
      async (failures) => {
        chmodSync(stop, 0o775);
        expectCode(
          failures,
          'config check --runner mit 775 auf /config/stop',
          runner(work, ['config', 'check', '--runner']),
          78,
        );
        chmodSync(stop, 0o755);
        const name = `ecclium-e2e-${runMark}-daemon`;
        must(
          compose([
            'run',
            '-d',
            '--no-deps',
            '--name',
            name,
            'runner',
            'runner',
          ]),
          'Der Start des Daemons',
        );
        try {
          await waitFor('Der Daemon', () => {
            const logs = docker(['logs', name]);
            return `${logs.stdout}${logs.stderr}`.includes('Der Runner läuft');
          });
          const pid1 = docker([
            'exec',
            name,
            'cat',
            '/proc/1/comm',
          ]).stdout.trim();
          if (pid1 !== 'docker-init')
            failures.push(`PID 1 im Container ist ${pid1}, nicht das init.`);
          failures.push(...hardeningOf(name, limits));
          docker(['stop', name]);
          const code = docker([
            'inspect',
            '-f',
            '{{.State.ExitCode}}',
            name,
          ]).stdout.trim();
          if (code !== '143')
            failures.push(
              `docker stop beendete den Daemon mit ${code} statt 143.`,
            );
          const logs = docker(['logs', name]);
          if (
            !`${logs.stdout}${logs.stderr}`.includes(
              '"event":"process_sigterm"',
            )
          ) {
            failures.push('Das Log des Daemons nennt process_sigterm nicht.');
          }
        } finally {
          docker(['rm', '-f', name]);
        }
        failures.push(...judgePeaks(peaks, limits));
      },
    );

    // 6. doctor from inside.
    // Exit 0 says: no finding on the way out, the providers, the routines
    // and the accounts; the findings on the policy do not count.
    await proof('ecclium doctor im internen Netz ohne Befund', (failures) => {
      const report = runner(work, ['doctor']);
      expectCode(failures, 'ecclium doctor', report, 0);
      if (!/ecclium-doctor\.invalid.*403/u.test(report.stdout)) {
        failures.push(
          'Der Bericht von doctor nennt die Abweisung eines Ziels ausserhalb der Liste nicht.',
        );
      }
    });
  } catch (error) {
    proofs.push({
      name: 'Aufbau',
      failures: [error instanceof Error ? error.message : String(error)],
      ms: 0,
    });
    say(
      `FEHLER Aufbau: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    report(nodeImage, squidImage, limits);
    cleanup(work, nodeImage);
  }
  return proofs.every((done) => done.failures.length === 0) ? 0 : 1;
};

const report = (
  nodeImage: string,
  squidImage: string,
  limits: { memory: number; pids: number },
): void => {
  const highest = highestPeak(peaks);
  const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  // A kernel without pids.peak gives no count; the limit still holds.
  const processes =
    highest.pids === 0
      ? `Prozesse vom Kernel nicht gemessen, Grenze ${String(limits.pids)}`
      : `Prozesse ${String(highest.pids)} von ${String(limits.pids)}`;
  const line = `Höchstwerte aus ${String(peaks.length)} gemessenen Läufen: Speicher ${mib(highest.memory)} MiB von ${mib(limits.memory)} MiB, ${processes}.`;
  say(line);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary === undefined || summary === '') return;
  const lines = [
    '## E2E des Runner-Container-Vertrags',
    '',
    '| Beleg | Ergebnis | Dauer |',
    '| --- | --- | --- |',
    ...proofs.map(
      (done) =>
        `| ${done.name} | ${done.failures.length === 0 ? 'bestanden' : done.failures.join(' ')} | ${String(Math.round(done.ms / 1000))} s |`,
    ),
    '',
    line,
    '',
    `Images: \`${nodeImage}\`, \`${squidImage}\`.`,
    '',
  ];
  appendFileSync(summary, `${lines.join('\n')}\n`);
};

const cleanup = (work: string, image: string): void => {
  compose(['down', '--remove-orphans', '--timeout', '5']);
  for (const volume of volumes) docker(['volume', 'rm', '-f', volume]);
  if (process.env['E2E_KEEP'] === '1') {
    say(`Der Arbeitsordner bleibt: ${work}`);
    return;
  }
  // Back to the user of the job, so that it can remove the folder.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'DAC_READ_SEARCH',
    '-v',
    `${work}:/v`,
    image,
    'chown',
    '-R',
    `${String(uid)}:${String(gid)}`,
    '/v',
  ]);
  rmSync(work, { recursive: true, force: true });
};

if (import.meta.main) process.exitCode = await main();
