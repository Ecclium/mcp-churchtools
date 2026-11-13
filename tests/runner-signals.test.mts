import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, describe, expect, it } from 'vitest';

import { guardPreload } from './support/no-network.mts';

// The daemon of the runner as a real process (ADR 0033): `ecclium runner`,
// that is packages/cli/src/bin.ts, from source with the resolution hook of
// the stdio test and the network guard alone in NODE_OPTIONS (ADR 0052),
// over real temporary folders with one routine that is never due, so that
// no run reads, asks a model or writes. The tests of the command replace
// the process; here the listeners of the process, its end after a signal
// and that nothing holds it afterwards are real. All data are made up.

const bin = fileURLToPath(
  new URL('../packages/cli/src/bin.ts', import.meta.url),
);
const hooks = new URL('fixtures/stdio/hooks.mts', import.meta.url).href;
const timeout = 60_000;

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

const privateDir = (path: string): string => {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};

const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

// Reads a file and its mode through one descriptor.
const readWithMode = (path: string): { text: string; mode: number } => {
  const fd = openSync(path, 'r');
  try {
    return { text: readFileSync(fd, 'utf8'), mode: fstatSync(fd).mode & 0o777 };
  } finally {
    closeSync(fd);
  }
};

/** The folders and variables of one runner, with a canary in every path. */
const setup = () => {
  const canary = makeCanary('token');
  const base = mkdtempSync(
    join(tmpdir(), `ecclium-runner-${canary.cores[0] ?? ''}-`),
  );
  folders.push(base);
  const stateDir = privateDir(join(base, 'state'));
  // The folder of the kill switches, which the runner requires
  // (ADR 0036).
  const stopDir = privateDir(join(stateDir, 'stop'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const token = makeCanary('token');
  privateFile(join(tokensDir, 'ct_token_runner'), `${token.value}\n`);
  const configDir = privateDir(join(base, 'config'));
  const routinesDir = privateDir(join(base, 'routines'));
  privateDir(join(routinesDir, 'prompts'));
  privateDir(join(routinesDir, 'templates'));
  const id = 'jahres-entwurf';
  privateFile(
    join(routinesDir, `${id}.yaml`),
    JSON.stringify({
      schema: 'routine.v1',
      id,
      // Once a year: the last trigger lies more than 31 days back.
      schedule: '0 6 1 1 *',
      inputs: [
        {
          name: 'termine',
          tool: 'ct_events_list',
          params: { from: '+0d', to: '+14d' },
          maxItems: 30,
        },
      ],
      generate: {
        prompt: `prompts/${id}.md`,
        model: 'default',
        output: {
          blocks: {
            termine: {
              maxItems: 10,
              fields: { titel: { type: 'text', maxLength: 80 } },
            },
          },
        },
      },
      template: `templates/${id}.md`,
      output: {
        target: 'draft',
        channel: 'file',
        idempotencyKey: `${id}:{isoWeek}`,
      },
      notify: [{ channel: 'stdout' }],
    }),
  );
  privateFile(join(routinesDir, 'prompts', `${id}.md`), 'Fasse zusammen.\n');
  privateFile(
    join(routinesDir, 'templates', `${id}.md`),
    '{{#termine}}\n- {{titel}}\n{{/termine}}\n',
  );
  const metricsFile = join(base, 'metrics', 'runner.prom');
  const environment: Record<string, string> = {
    NODE_OPTIONS: guardPreload,
    ECCLIUM_CHURCHTOOLS_URL: 'https://demo.example',
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_POLICY_FILE: privateFile(
      join(configDir, 'policy.json'),
      JSON.stringify({
        schema: 'policy.v1',
        interactive: { inquiriesTo: 'Sekretariat' },
        unattended: [],
      }),
    ),
    ECCLIUM_PROVIDERS_FILE: privateFile(
      join(configDir, 'providers.json'),
      JSON.stringify({
        schema: 'providers.v1',
        providers: [
          {
            alias: 'default',
            vendor: 'example',
            model: 'example-model-1',
            hostingCountry: 'CH',
            endpoint: 'https://model.example.org/v1/chat/completions',
            structuredOutput: true,
            apiKeyFile: join(configDir, 'model-key'),
          },
        ],
      }),
    ),
    ECCLIUM_ROUTINES_DIR: routinesDir,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_KILL_SWITCH_DIR: stopDir,
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_DRAFTS_DIR: join(base, 'drafts'),
    ECCLIUM_RUNNER_METRICS_FILE: metricsFile,
    // The test reaches no network, so the runner runs without the
    // boundary on purpose (ADR 0035).
    ECCLIUM_EGRESS: 'off',
    ECCLIUM_PSEUDONYM_KEY_FILE: privateFile(
      join(configDir, 'pseudonym-key'),
      `${createHash('sha256').update('runner-signals').digest('hex')}\n`,
    ),
  };
  return { canary, token, base, metricsFile, environment, id };
};

/** What the child said and how it ended. */
interface Ended {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Starts the daemon, sends the signal once it says that it runs, and
 * gives how it ended.
 */
const runUntil = (
  environment: Readonly<Record<string, string>>,
  signal: NodeJS.Signals,
): Promise<Ended> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--conditions=@ecclium/source', `--import=${hooks}`, bin, 'runner'],
      { env: { ...environment }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let sent = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      // After the first pass: the metrics file follows it.
      if (!sent && stderr.includes('Der Runner läuft mit 1 Routine')) {
        sent = true;
        setTimeout(() => child.kill(signal), 500);
      }
    });
    child.on('error', reject);
    child.on('exit', (code, ended) => {
      resolve({ code, signal: ended, stdout, stderr });
    });
  });

describe('ecclium runner as a real process', () => {
  it.each([
    ['SIGTERM', 143, 'process_sigterm'],
    ['SIGINT', 130, 'process_sigint'],
    ['SIGHUP', 129, 'process_sighup'],
  ] as const)(
    'ends after %s with %i, closes its audit file and leaves nothing behind that holds it',
    async (signal, exit, event) => {
      const t = setup();
      const ended = await runUntil(t.environment, signal);
      expect(ended.signal).toBeNull();
      expect(ended.code).toBe(exit);
      expect(ended.stderr).toContain(`"event":"${event}"`);
      expect(ended.stderr).toContain('"event":"audit_file_closed"');
      expect(ended.stderr).toContain('Der Runner hält an');
      // The pass wrote the metrics file before the signal, privately.
      const metrics = readWithMode(t.metricsFile);
      expect(metrics.mode).toBe(0o600);
      expect(metrics.text).toContain(
        `ecclium_runner_next_run_timestamp_seconds{routine="${t.id}"} `,
      );
      // Neither the token nor any path in what the process gave out.
      assertNoCanary(
        [ended.stdout, ended.stderr, metrics.text],
        [t.token, t.canary],
        'the output of the daemon',
      );
    },
    timeout,
  );
});
