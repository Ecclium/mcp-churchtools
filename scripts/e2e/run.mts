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
  existsSync,
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
  oneSectionPerPeriod,
  type Peak,
  peakOf,
  peakPrefix,
  type ProbeResult,
  routineId,
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
// The longest a proof may take, so that no change of day falls into it.
const proofWindowMs = 10 * 60_000;

const category = { id: 7, name: 'Berichte' } as const;
const pageTitle = 'Wochenbericht';
const allowed = ['churchtools.e2e.test:443', 'model.e2e.test:443'];
const refused = ['decoy.e2e.test:443'];

/** One proof and what failed in it. */
interface Proof {
  readonly name: string;
  readonly failures: string[];
  ms: number;
}

const proofs: Proof[] = [];
const peaks: Peak[] = [];

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
  if (call.measure) {
    const peak = peakOf(result.stdout);
    if (peak !== undefined) peaks.push(peak);
  }
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

const policyYaml = (
  guid: string,
  maxPerDay: number,
): string => `schema: policy.v1
interactive:
  inquiriesTo: Sekretariat
unattended:
  - routine: ${routineId}
    credential: berichte
    target: { kind: wiki_page, categoryId: ${String(category.id)}, guid: ${guid}, name: ${pageTitle} }
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
  writeFileSync(join(config, 'policy.yaml'), policyYaml(guid, 5), {
    mode: 0o644,
  });
  writeFileSync(join(config, 'policy-limit.yaml'), policyYaml(guid, 1), {
    mode: 0o644,
  });
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
  const data = `ecclium-e2e-data-${label}`;
  const keys = `ecclium-e2e-keys-${label}`;
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

const proof = async (
  name: string,
  body: (failures: string[]) => Promise<void> | void,
): Promise<void> => {
  const wait = waitBeforeProof(Date.now(), proofWindowMs, timeZone);
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

const patches = (service: string): number =>
  countCalls(reportOf(service)?.calls ?? [], 'PATCH', '/api/wiki/');

const pageText = (): string => reportOf('churchtools')?.page?.text ?? '';

const main = async (): Promise<number> => {
  for (const [name, path] of [
    ['Der gebaute Stand', builtCli],
    ['Der gebaute Write-Guard', builtSections],
  ] as const) {
    if (!existsSync(path)) {
      say(`${name} fehlt. Zuerst pnpm run build.`);
      return 1;
    }
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
      'Vertrag: frisches Volume von root hält den Start an, übergeben nicht',
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
        const probe = runner(
          work,
          ['/app/scripts/e2e/probe.mts', address, ...allowed, ...refused],
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
          failures.push(...judgeProbe(result, allowed, refused));
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
        failures.push(...oneSectionPerPeriod(pageText(), routineId));
        const faulty = withFault(readFileSync(builtSections, 'utf8'));
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
        if (oneSectionPerPeriod(pageText(), routineId).length === 0) {
          failures.push(
            'Mit dem eingebauten Fehler steht weiter genau ein Abschnitt je Periode; die Prüfung wäre blind.',
          );
        }
      },
    );

    // 4. The limit per day.
    freshVolumes('limit', nodeImage, true);
    await resetStandIns();
    await proof(
      'Tagesgrenze über zwei Container, und ein leeres /data schreibt wieder',
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

    // 5b. The rest of the contract.
    freshVolumes('contract', nodeImage, true);
    await proof(
      'Vertrag: Ordner der Kill-Switches, Signal und Grenzen',
      async (failures) => {
        chmodSync(stop, 0o775);
        expectCode(
          failures,
          'config check --runner mit 775 auf /config/stop',
          runner(work, ['config', 'check', '--runner']),
          78,
        );
        chmodSync(stop, 0o755);
        const name = 'ecclium-e2e-daemon';
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
  say(
    `Höchstwerte der Läufe: Speicher ${mib(highest.memory)} MiB von ${mib(limits.memory)} MiB, Prozesse ${String(highest.pids)} von ${String(limits.pids)}.`,
  );
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
    `Höchstwerte: Speicher ${mib(highest.memory)} MiB von ${mib(limits.memory)} MiB, Prozesse ${String(highest.pids)} von ${String(limits.pids)}.`,
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
