import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertNoCanary, makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { warningText } from '../messages/index.js';
import { aclHeader } from './acl.js';
import { initEgress } from './init.js';
import { egressInitTexts } from './texts.js';

// `ecclium init egress` over real temporary folders and files of the
// configuration of the runner (ADR 0035). It asks nothing over the
// network, so no double is needed. All names are made up.

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

// The path of the ping works like a secret (ADR 0009); it is made at run
// time, and no line may show it.
const pingCheck = `check-${createHash('sha256').update('init-egress').digest('hex').slice(0, 24)}`;

interface SetupOptions {
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /** The endpoint of the second provider. */
  readonly local?: string;
}

const setup = (options: SetupOptions = {}) => {
  const pathCanary = makeCanary('token');
  const base = mkdtempSync(
    join(tmpdir(), `ecclium-init-egress-${pathCanary.cores[0] ?? ''}-`),
  );
  cleanup.push(base);
  const configDir = privateDir(join(base, 'config'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const runnerToken = makeCanary('token');
  privateFile(join(tokensDir, 'ct_token_runner'), `${runnerToken.value}\n`);
  const providers = privateFile(
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
        {
          alias: 'lokal',
          vendor: 'example',
          model: 'example-model-2',
          hostingCountry: 'CH',
          endpoint:
            options.local ?? 'https://llm.example.org:8443/v1/chat/completions',
          structuredOutput: true,
          apiKeyFile: join(configDir, 'model-key'),
        },
      ],
    }),
  );
  const environment: Record<string, string | undefined> = {
    ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_POLICY_FILE: privateFile(
      join(configDir, 'policy.yaml'),
      'schema: policy.v1\n',
    ),
    ECCLIUM_ROUTINES_DIR: privateDir(join(base, 'routines')),
    ECCLIUM_STATE_DIR: privateDir(join(base, 'state')),
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_PROVIDERS_FILE: providers,
    ECCLIUM_RUNNER_PING_URL_FILE: privateFile(
      join(configDir, 'ping-url'),
      `https://ping.example.org/ping/${pingCheck}\n`,
    ),
    ECCLIUM_EGRESS_PROXY: 'http://egress:3128',
    ECCLIUM_EGRESS_ALLOW_LAN: 'llm.example.org:8443',
  };
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) Reflect.deleteProperty(environment, name);
    else environment[name] = value;
  }
  const init = (stdoutWorks = true) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = initEgress({
      environment,
      execArgv: [],
      output: {
        stdout: (line) => stdoutWorks && stdout.push(line) > 0,
        stderr: (line) => stderr.push(line) > 0,
      },
    });
    assertNoCanary([stdout, stderr], [pathCanary, runnerToken], 'the list');
    expect([...stdout, ...stderr].join('\n')).not.toContain(pingCheck);
    return { code, stdout, stderr };
  };
  return { init };
};

describe('ecclium init egress', () => {
  it('writes the targets of ChurchTools, of each provider and of the ping as lines acl only', () => {
    const { code, stdout, stderr } = setup().init();
    expect(code).toBe(exitCodes.ok);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      aclHeader,
      '# ChurchTools',
      'acl ecclium_host_1 dstdomain -n example.church.tools',
      'acl ecclium_port_1 port 443',
      'acl ecclium_public all-of ecclium_host_1 ecclium_port_1',
      '# Anbieter ‹default›',
      'acl ecclium_host_2 dstdomain -n model.example.org',
      'acl ecclium_port_2 port 443',
      'acl ecclium_public all-of ecclium_host_2 ecclium_port_2',
      '# Anbieter ‹lokal›, lokales Netz',
      'acl ecclium_host_3 dstdomain -n llm.example.org',
      'acl ecclium_port_3 port 8443',
      'acl ecclium_lan all-of ecclium_host_3 ecclium_port_3',
      '# Ping des Runners',
      'acl ecclium_host_4 dstdomain -n ping.example.org',
      'acl ecclium_port_4 port 443',
      'acl ecclium_public all-of ecclium_host_4 ecclium_port_4',
    ]);
  });

  it('writes nothing to stdout for an invalid configuration', () => {
    const { code, stdout, stderr } = setup({
      extra: { ECCLIUM_TIME_ZONE: undefined },
    }).init();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('ECCLIUM_TIME_ZONE');
    expect(stderr.at(-1)).toBe(egressInitTexts.config_invalid);
  });

  it('refuses a target in the local network that is no origin of the configuration', () => {
    const { code, stdout, stderr } = setup({
      extra: { ECCLIUM_EGRESS_ALLOW_LAN: 'ping.example.org:443' },
    }).init();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('ECCLIUM_EGRESS_ALLOW_LAN');
  });

  it('writes nothing for a target on another port outside the local network, and names its role', () => {
    const { code, stdout, stderr } = setup({
      extra: { ECCLIUM_EGRESS_ALLOW_LAN: undefined },
    }).init();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([egressInitTexts.port(['Anbieter ‹lokal›'])]);
    expect(stderr[0]).not.toContain('llm.example.org');
    expect(stderr[0]).not.toContain('8443');
  });

  it('writes the list for a runner with off, with the warnings of its start', () => {
    const { code, stdout, stderr } = setup({
      extra: { ECCLIUM_EGRESS_PROXY: undefined, ECCLIUM_EGRESS: 'off' },
    }).init();
    expect(code).toBe(exitCodes.ok);
    expect(stdout[0]).toBe(aclHeader);
    expect(stderr).toEqual([
      warningText('egress_off'),
      warningText('egress_allow_lan_unused'),
    ]);
  });

  it('gives 74 when stdout takes no line', () => {
    const { code, stdout, stderr } = setup().init(false);
    expect(code).toBe(exitCodes.ioError);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([egressInitTexts.output_cut]);
  });
});
