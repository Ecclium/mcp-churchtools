import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkRunnerTokensDir,
  createRunId,
  createStdioIdentity,
  createStdioTenantResolver,
  createToolCatalog,
  type EccliumConfig,
  loadConfig,
  type ToolCatalog,
  readRunnerToken,
  runAssignmentOf,
} from '@ecclium/mcp-churchtools-core';
import {
  createStderrWriter,
  createWriteHalt,
  openAuditFile,
  prepareQuotaFolder,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  assertNoCanary,
  assertPlanted,
  type Canary,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import { createCorePlugin } from '@ecclium/mcp-churchtools-tools';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type AccountPipelineResult,
  composeAccountPipeline,
  composeRunPipeline,
  type RunPipelineResult,
} from './run-pipeline.js';

// The pipeline of one run with the token of its account (ADR 0033): which
// token reaches ChurchTools, that a routine without an entry reads with the
// own account of the runner and only in the runner, that a new token file
// counts from the next build on, that nothing is built without a folder
// and a token file the checks accept, checked anew for each build, and
// that the token of the account shows nowhere. The double of
// ChurchTools accepts only the token a test names. All data are made up.

const now = Date.UTC(2026, 10, 11, 7);
const clock = Object.freeze({ now: Object.freeze(() => now) });
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};
// The routines of the policy of the tests: one with the alias berichte,
// one with the alias andere, whose token file no test writes, one whose
// entries name both, and one without an entry.
const routineId = 'dienstplan-test';
const otherRoutine = 'fremd-test';
const mixedRoutine = 'gemischt-test';
const unlisted = 'ohne-test';

const entryOf = (routine: string, credential: string, category: number) => ({
  routine,
  credential,
  target: {
    kind: 'wiki_category',
    id: category,
    name: `Kategorie ${String(category)}`,
  },
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 1,
  maxPerDay: 2,
});

// Every folder of a test and everything open, removed and closed after it.
const cleanup: string[] = [];
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((item) => item.close().catch(() => undefined)),
  );
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const privateDir = (path: string): string => {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};

// A token file, with the mode set after the write, since the umask could
// take bits off the mode of the write.
const tokenFile = (path: string, token: Canary, mode = 0o600): void => {
  writeFileSync(path, `${token.value}\n`, { mode });
  chmodSync(path, mode);
};

/** What a test sets up differently. */
interface SetupOptions {
  /** Whether `ECCLIUM_RUNNER_TOKENS_DIR` is set; by default it is. */
  readonly tokensDir?: boolean;
}

const setup = (options: SetupOptions = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-run-pipeline-'));
  cleanup.push(base);
  // The folder of state, for the audit file that a read of a tool that
  // names persons needs (ADR 0028, ADR 0064).
  const stateDir = privateDir(join(base, 'state'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const serverCanary = makeCanary('token');
  const accountToken = makeCanary('token');
  const accountFile = join(tokensDir, 'ct_token_berichte');
  tokenFile(accountFile, accountToken);
  // The own account of the runner, for a routine without an entry.
  const runnerToken = makeCanary('token');
  tokenFile(join(tokensDir, 'ct_token_runner'), runnerToken);
  // JSON is YAML, so the loader of the policy reads it as it is.
  const policyFile = join(base, 'policy.json');
  writeFileSync(
    policyFile,
    JSON.stringify({
      schema: 'policy.v1',
      unattended: [
        entryOf(routineId, 'berichte', 7),
        entryOf(otherRoutine, 'andere', 8),
        entryOf(mixedRoutine, 'berichte', 21),
        entryOf(mixedRoutine, 'andere', 22),
      ],
    }),
    { mode: 0o600 },
  );
  chmodSync(policyFile, 0o600);
  const loaded = loadConfig({
    environment: {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: serverCanary.value,
      ECCLIUM_REDACTION: 'standard',
      ECCLIUM_TOOLSETS: 'wiki',
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_POLICY_FILE: policyFile,
      // Every line the pipeline can write, so that a leak in one shows.
      ECCLIUM_LOG_LEVEL: 'debug',
      ...(options.tokensDir === false
        ? {}
        : { ECCLIUM_RUNNER_TOKENS_DIR: tokensDir }),
    },
    transport: 'stdio',
  });
  if (!loaded.ok) throw new Error('the configuration of the test is invalid');
  const config: EccliumConfig = loaded.config;
  // The same settings as the runner has them: only the kind differs, which
  // decides whether a routine without an entry may read at all.
  const runnerConfig: EccliumConfig = Object.freeze({
    ...config,
    transport: 'runner',
  });

  const audit = openAuditFile({
    stateDir,
    clock,
    pid: process.pid,
    retentionMonths: config.auditRetentionMonths,
  });
  if (!audit.ok) throw new Error('no audit file');
  open.push({
    close: () => {
      audit.writer.close();
      return Promise.resolve();
    },
  });
  if (!prepareQuotaFolder(stateDir).ok) throw new Error('no quota folder');

  const lines: string[] = [];
  const writer = createStderrWriter({
    writeSync: (_fd, buffer, offset, length) => {
      lines.push(
        Buffer.from(buffer)
          .subarray(offset, offset + length)
          .toString('utf8'),
      );
      return length;
    },
  });
  const catalog = createToolCatalog({
    core: createCorePlugin(),
    plugins: [],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });

  // The token the double accepts; any other gets 401, as ChurchTools
  // answers a token it does not know.
  const accepted = { token: accountToken };
  const doubles: MockedHttpTransport[] = [];
  let closed = 0;
  const createTransport = (given: HttpTransportOptions): HttpTransport => {
    // With the logger of the pipeline, so that the lines of the transport,
    // which holds the token, reach stderr as in production.
    const double = createChurchToolsDouble({
      token: given.token,
      origin: given.origin,
      logger: given.logger,
      clock: given.clock,
    });
    open.push(double);
    doubles.push(double);
    double
      .intercept({
        path: '/api/wiki/categories',
        method: 'GET',
        headers: { authorization: `Login ${accepted.token.value}` },
      })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({ data: [{ id: 7, name: 'Berichte' }] }),
        responseOptions: json,
      }))
      .persist();
    double
      .intercept({ path: '/api/wiki/categories', method: 'GET' })
      .reply(401, '{}', json)
      .persist();
    return {
      ...double.transport,
      close: () => {
        closed += 1;
        return double.transport.close();
      },
    };
  };

  const build = (
    routine: string,
    extra: {
      readonly readToken?: typeof readRunnerToken;
      readonly checkTokensDir?: typeof checkRunnerTokensDir;
      readonly ownAccount?: boolean;
      readonly runner?: boolean;
    } = {},
  ): RunPipelineResult => {
    const { runner, ...rest } = extra;
    const built = composeRunPipeline({
      config: runner === true ? runnerConfig : config,
      catalog,
      writer,
      clock,
      auditFile: audit.writer,
      createTransport,
      routineId: routine,
      writeHalt: createWriteHalt(),
      ...rest,
    });
    if (built.ok) open.push({ close: () => built.close() });
    return built;
  };

  // One read of a run through the pipeline, as the port of composeRun reads.
  const read = async (built: RunPipelineResult, routine = routineId) => {
    if (!built.ok) throw new Error(`no pipeline: ${built.code}`);
    return built.pipeline.callForRun(
      'ct_wiki_categories_list',
      {},
      {
        assignment: runAssignmentOf(routine),
        redaction: 'standard',
        features: [],
        signal: new AbortController().signal,
        run: { runId: createRunId(), routineId: routine },
        maxEntries: 10,
      },
    );
  };

  // The pipeline with an alias the operator names, with a configuration
  // that only reads unless a test passes another.
  const buildAccount = (
    credential: string,
    extra: {
      readonly config?: EccliumConfig;
      readonly catalog?: ToolCatalog;
      readonly checkTokensDir?: typeof checkRunnerTokensDir;
    } = {},
  ): AccountPipelineResult => {
    const built = composeAccountPipeline({
      config: extra.config ?? Object.freeze({ ...config, readOnly: true }),
      catalog: extra.catalog ?? catalog,
      writer,
      clock,
      auditFile: audit.writer,
      createTransport,
      credential,
      ...(extra.checkTokensDir === undefined
        ? {}
        : { checkTokensDir: extra.checkTokensDir }),
    });
    if (built.ok) open.push({ close: () => built.close() });
    return built;
  };

  // One read of the operator, as ecclium policy init reads.
  const readAsOperator = async (built: AccountPipelineResult) => {
    if (!built.ok) throw new Error(`no pipeline: ${built.code}`);
    return built.pipeline.call(
      'ct_wiki_categories_list',
      {},
      {
        assignment: await createStdioTenantResolver().resolve(
          createStdioIdentity(config),
        ),
        mode: 'operator',
        redaction: 'standard',
        readOnly: true,
        features: Object.freeze([]),
        signal: new AbortController().signal,
      },
    );
  };

  return {
    config,
    serverCanary,
    accountToken,
    runnerToken,
    accountFile,
    tokensDir,
    accepted,
    doubles,
    lines,
    closed: () => closed,
    build,
    read,
    buildAccount,
    readAsOperator,
  };
};

describe('the token of the pipeline of a run', () => {
  it('reads with the own account of the runner for a routine without an entry', async () => {
    const { runnerToken, accepted, doubles, build, read } = setup();
    accepted.token = runnerToken;
    const outcome = await read(
      build(unlisted, { runner: true, ownAccount: true }),
      unlisted,
    );
    expect(outcome).toMatchObject({
      ok: true,
      data: { categories: [{ id: 7 }] },
    });
    expect(doubles).toHaveLength(1);
    expect(doubles[0]?.calls()[0]?.headers['authorization']).toBe(
      `Login ${runnerToken.value}`,
    );
  });

  it('never reads with the token of the configuration for a routine without an entry', async () => {
    const { serverCanary, accepted, doubles, build, read } = setup();
    accepted.token = serverCanary;
    await expect(
      read(build(unlisted, { runner: true, ownAccount: true }), unlisted),
    ).resolves.toMatchObject({ ok: false, code: 'auth' });
    expect(doubles[0]?.calls()[0]?.headers['authorization']).not.toBe(
      `Login ${serverCanary.value}`,
    );
  });

  it('builds a run without an entry only in the runner', () => {
    const { doubles, build } = setup();
    expect(() => build(unlisted, { ownAccount: true })).toThrow(TypeError);
    expect(doubles).toHaveLength(0);
  });

  it('reads with the token file of the alias, and never with the token of the configuration', async () => {
    const { serverCanary, accountToken, doubles, build, read } = setup();
    expect(serverCanary.value).not.toBe(accountToken.value);
    const built = build(routineId);
    await expect(read(built)).resolves.toMatchObject({
      ok: true,
      data: { categories: [{ id: 7 }] },
    });
    expect(doubles.at(-1)?.calls()[0]?.headers['authorization']).toBe(
      `Login ${accountToken.value}`,
    );
    // The double takes only the token of the account, so the own account
    // of the runner cannot read in its place.
    await expect(
      read(build(unlisted, { runner: true, ownAccount: true }), unlisted),
    ).resolves.toMatchObject({ ok: false, code: 'auth' });
  });

  it('takes a changed token file with the next build, without a restart', async () => {
    const { accountFile, accepted, doubles, build, read } = setup();
    await expect(read(build(routineId))).resolves.toMatchObject({
      ok: true,
    });
    const renewed = makeCanary('token');
    tokenFile(accountFile, renewed);
    accepted.token = renewed;
    await expect(read(build(routineId))).resolves.toMatchObject({
      ok: true,
    });
    expect(doubles).toHaveLength(2);
    expect(doubles[1]?.calls()[0]?.headers['authorization']).toBe(
      `Login ${renewed.value}`,
    );
  });
});

describe('a pipeline of a run without a token file the checks accept', () => {
  it('is not built for an alias without the folder of the tokens', () => {
    const { doubles, build } = setup({ tokensDir: false });
    const asked: string[] = [];
    const built = build(routineId, {
      readToken: (dir, alias) => {
        asked.push(alias);
        return readRunnerToken(dir, alias);
      },
    });
    expect(built).toEqual({ ok: false, code: 'runner_tokens_dir_unset' });
    expect(asked).toEqual([]);
    // Also for a routine without an entry: never the token of the
    // configuration.
    expect(build(unlisted, { runner: true, ownAccount: true })).toEqual({
      ok: false,
      code: 'runner_tokens_dir_unset',
    });
    // No transport, so the token of the configuration went nowhere.
    expect(doubles).toHaveLength(0);
  });

  it('checks the folder of the tokens anew for each build', () => {
    const { tokensDir, doubles, build } = setup();
    let checks = 0;
    const checkTokensDir: typeof checkRunnerTokensDir = (dir) => {
      checks += 1;
      return checkRunnerTokensDir(dir);
    };
    expect(build(routineId, { checkTokensDir })).toMatchObject({ ok: true });
    // The folder lost its rights while the runner ran: the next run reads
    // no token from it.
    chmodSync(tokensDir, 0o770);
    expect(build(routineId, { checkTokensDir })).toEqual({
      ok: false,
      code: 'runner_tokens_dir_mode',
    });
    expect(build(unlisted, { runner: true, ownAccount: true })).toEqual({
      ok: false,
      code: 'runner_tokens_dir_mode',
    });
    expect(checks).toBe(2);
    expect(doubles).toHaveLength(1);
    chmodSync(tokensDir, 0o700);
  });

  it('is not built for a token file that group or others may read', () => {
    const { accountFile, accountToken, doubles, build } = setup();
    tokenFile(accountFile, accountToken, 0o640);
    expect(build(routineId)).toEqual({ ok: false, code: 'token_file_mode' });
    expect(doubles).toHaveLength(0);
  });

  it('is not built for an alias without its token file', () => {
    const { doubles, build } = setup();
    expect(build(otherRoutine)).toEqual({
      ok: false,
      code: 'token_file_missing',
    });
    expect(doubles).toHaveLength(0);
  });

  it('is not built for a routine without an account unless the runner asks for its own', () => {
    const { doubles, build } = setup();
    // Without ownAccount, also with the configuration of the runner, which
    // holds the own account of the runner (ADR 0036).
    for (const runner of [false, true]) {
      expect(build(unlisted, { runner })).toEqual({
        ok: false,
        code: 'run_credential_missing',
      });
    }
    expect(doubles).toHaveLength(0);
  });

  it('is not built for a routine whose entries name two accounts', () => {
    const { doubles, build } = setup();
    expect(build(mixedRoutine)).toEqual({
      ok: false,
      code: 'run_credential_mixed',
    });
    expect(doubles).toHaveLength(0);
  });
});

describe('the token of the account of a run', () => {
  it('shows in no line on stderr and in no outcome, also when the run fails', async () => {
    const { accountFile, accountToken, accepted, lines, build, read } = setup();
    assertPlanted(`${accountToken.value}\n`, [accountToken], 'the token file');
    const outcomes: unknown[] = [];
    // A read that passes, and one that ChurchTools refuses.
    outcomes.push(await read(build(routineId)));
    accepted.token = makeCanary('token');
    const refused = await read(build(routineId));
    expect(refused).toMatchObject({ ok: false, code: 'auth' });
    outcomes.push(refused);
    // A token file the checks refuse.
    chmodSync(accountFile, 0o640);
    const unbuilt = build(routineId);
    expect(unbuilt).toEqual({ ok: false, code: 'token_file_mode' });
    outcomes.push(unbuilt);
    // The lines of the transport are among them: one answer per read.
    const events = lines
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => (JSON.parse(line) as { event?: string }).event);
    expect(events.filter((event) => event === 'http_response')).toHaveLength(2);
    assertNoCanary(lines.join(''), [accountToken], 'the lines on stderr');
    assertNoCanary(outcomes, [accountToken], 'the outcomes');
  });
});

describe('the end of the pipeline of a run', () => {
  it('closes the transport of the run', async () => {
    const { closed, build } = setup();
    const built = build(routineId);
    if (!built.ok) throw new Error(`no pipeline: ${built.code}`);
    expect(closed()).toBe(0);
    await built.close();
    expect(closed()).toBe(1);
  });
});

describe('the pipeline with an account the operator names', () => {
  it('reads with the token of the alias it names', async () => {
    const { accountToken, doubles, buildAccount, readAsOperator } = setup();
    const outcome = await readAsOperator(buildAccount('berichte'));
    expect(outcome).toMatchObject({
      ok: true,
      data: { categories: [{ id: 7 }] },
    });
    expect(doubles).toHaveLength(1);
    expect(doubles[0]?.calls()[0]?.headers['authorization']).toBe(
      `Login ${accountToken.value}`,
    );
  });

  it('never reads with the token of the configuration', async () => {
    const { serverCanary, accepted, doubles, buildAccount, readAsOperator } =
      setup();
    accepted.token = serverCanary;
    await expect(
      readAsOperator(buildAccount('berichte')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(doubles[0]?.calls()[0]?.headers['authorization']).not.toBe(
      `Login ${serverCanary.value}`,
    );
  });

  it('is not built without the token file of the alias or its folder', () => {
    const { doubles, buildAccount } = setup();
    expect(buildAccount('andere')).toEqual({
      ok: false,
      code: 'token_file_missing',
    });
    expect(
      buildAccount('berichte', {
        checkTokensDir: () =>
          Object.freeze({ ok: false, code: 'runner_tokens_dir_mode' }),
      }),
    ).toEqual({ ok: false, code: 'runner_tokens_dir_mode' });
    expect(doubles).toHaveLength(0);
    const unset = setup({ tokensDir: false });
    expect(unset.buildAccount('berichte')).toEqual({
      ok: false,
      code: 'runner_tokens_dir_unset',
    });
    expect(unset.doubles).toHaveLength(0);
  });

  it('is never built with a configuration that may write or a write tool', () => {
    const { config, doubles, buildAccount } = setup();
    expect(() =>
      buildAccount('berichte', {
        config: Object.freeze({ ...config, readOnly: false }),
      }),
    ).toThrow(TypeError);
    // A configuration that only reads, with a catalog that writes.
    expect(() =>
      buildAccount('berichte', {
        catalog: createToolCatalog({
          core: createCorePlugin({ writing: true }),
          plugins: [],
          readOnly: false,
          toolsets: new Set(['wiki'] as const),
        }),
      }),
    ).toThrow(TypeError);
    expect(doubles).toHaveLength(0);
  });
});
