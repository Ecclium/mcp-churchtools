import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeRunTool, loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  assertNoCanary,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import {
  loadRoutines,
  prepareRun,
  runCredentialOf,
} from '@ecclium/mcp-churchtools-workflows';
import { afterEach, describe, expect, it } from 'vitest';

import type { Output } from '../output/index.js';
import { createRunnerCatalog } from '../runner/start.js';
import { initPolicy } from './init.js';
import {
  accountNamesFailedText,
  accountText,
  draftNeedsNoEntryText,
  outputCutText,
  routineProposalTexts,
  routinesLoadText,
} from './texts.js';

// `ecclium policy init --routine` against real folders of routines and
// tokens and the double of ChurchTools, which answers only the token of
// the account of the alias and keeps the categories and pages of a wiki.
// All data are made up.

const routineId = 'dienstplan-test';
const pageTitle = 'Dienstplan-Auswertung';
const guid = '00000000-0000-4000-8000-0000000000c1';
const otherGuid = '00000000-0000-4000-8000-0000000000c2';
const tool = 'ct_wiki_page_append_section';
const json = { headers: { 'content-type': 'application/json' } };

const template = [
  '### Dienstplan {{period}}',
  '',
  '{{#unbesetzt}}',
  '- {{datum}}: {{dienst}}',
  '{{/unbesetzt}}',
  '',
].join('\n');

// The template of a routine with the checks of the core.
const checksTemplate = [
  '### Pflege {{period}}',
  '',
  '{{#stalePages}}',
  '- {{page}}',
  '{{/stalePages}}',
  '',
].join('\n');

/** How a routine of a test differs from the plain one. */
interface RoutineOptions {
  readonly schedule?: string;
  readonly target?: 'wiki' | 'draft';
  readonly redaction?: 'strict' | 'standard';
  readonly category?: string;
  readonly page?: string;
}

const routineValueOf = (id: string, options: RoutineOptions = {}) => ({
  schema: 'routine.v1',
  id,
  schedule: options.schedule ?? '0 6 * * MON',
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
    ...(options.redaction === undefined
      ? {}
      : { redaction: options.redaction }),
    output: {
      blocks: {
        unbesetzt: {
          maxItems: 10,
          fields: {
            datum: { type: 'date' },
            dienst: { type: 'text', maxLength: 80 },
          },
        },
      },
    },
  },
  template: `templates/${id}.md`,
  output:
    options.target === 'draft'
      ? { target: 'draft', channel: 'file', idempotencyKey: `${id}:{isoWeek}` }
      : {
          target: 'wiki',
          tool,
          scope: {
            category: options.category ?? 'Berichte',
            page: options.page ?? pageTitle,
          },
          idempotencyKey: `${id}:{isoWeek}`,
        },
});

// A routine with the checks of the core instead of a model.
const checksValueOf = (id: string) => ({
  schema: 'routine.v1',
  id,
  schedule: '0 7 1 * *',
  checks: [{ check: 'stalePages', olderThanDays: 365, maxItems: 50 }],
  template: `templates/${id}.md`,
  output: {
    target: 'wiki',
    tool,
    scope: { category: 'Berichte', page: pageTitle },
    idempotencyKey: `${id}:{month}`,
  },
});

// Every folder of a test and everything open, removed and closed after it.
const cleanup: string[] = [];
const open: MockedHttpTransport[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
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

const privateFile = (path: string, text: string): string => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

/** A page of the wiki of the double. */
interface FakePage {
  readonly categoryId: number;
  readonly guid: string;
  readonly title: string;
}

/** What a test sets up differently. */
interface SetupOptions {
  /** The routines in the folder, by ID; by default the plain one. */
  readonly routines?: Readonly<Record<string, unknown>>;
  /** The file of the policy, or none. */
  readonly policy?: unknown;
  /** Variables to set or, with undefined, to leave out. */
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /** The categories of the wiki. */
  readonly categories?: readonly {
    readonly id: number;
    readonly name: string;
  }[];
  /** The pages of the wiki. */
  readonly pages?: readonly FakePage[];
}

const setup = (options: SetupOptions = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'ecclium-policy-routine-'));
  cleanup.push(base);
  const stateDir = privateDir(join(base, 'state'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const configDir = privateDir(join(base, 'config'));
  const routinesDir = privateDir(join(base, 'routines'));
  privateDir(join(routinesDir, 'prompts'));
  privateDir(join(routinesDir, 'templates'));
  const serverCanary = makeCanary('token');
  const accountToken = makeCanary('token');
  const runnerToken = makeCanary('token');
  privateFile(join(tokensDir, 'ct_token_berichte'), `${accountToken.value}\n`);
  // The own account of the runner, which the configuration of the runner
  // requires and the command never reads with.
  privateFile(join(tokensDir, 'ct_token_runner'), `${runnerToken.value}\n`);
  for (const [id, value] of Object.entries(
    options.routines ?? { [routineId]: routineValueOf(routineId) },
  )) {
    // JSON is YAML, so the loader reads the routine as it is.
    privateFile(join(routinesDir, `${id}.yaml`), JSON.stringify(value));
    privateFile(join(routinesDir, 'prompts', `${id}.md`), 'Fasse zusammen.\n');
    privateFile(
      join(routinesDir, 'templates', `${id}.md`),
      typeof value === 'object' && value !== null && 'checks' in value
        ? checksTemplate
        : template,
    );
  }
  // The configuration of the runner, as its container holds it (ADR 0036):
  // without the token of the server, with the folder of the kill switches
  // and a way out, and with a file of the policy, by default one without
  // any entry, as before the first entry of a routine.
  const environment: Record<string, string> = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_KILL_SWITCH_DIR: privateDir(join(base, 'stop')),
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_ROUTINES_DIR: routinesDir,
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_EGRESS: 'off',
    ECCLIUM_LOG_LEVEL: 'debug',
    ECCLIUM_POLICY_FILE: privateFile(
      join(configDir, 'policy.json'),
      JSON.stringify(options.policy ?? { schema: 'policy.v1' }),
    ),
  };
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) Reflect.deleteProperty(environment, name);
    else environment[name] = value;
  }

  const wiki = {
    categories: options.categories ?? [{ id: 7, name: 'Berichte' }],
    pages: options.pages ?? [{ categoryId: 7, guid, title: pageTitle }],
    // The token the double answers; any other gets 401.
    accepted: accountToken,
    pagesStatus: 200,
    // The token of every request, in order, as the double saw it.
    seen: [] as string[],
  };
  const sawRequest = (request: { readonly headers?: unknown }): void => {
    const headers = request.headers as Record<string, unknown> | undefined;
    const value = headers?.['authorization'];
    wiki.seen.push(typeof value === 'string' ? value : '');
  };
  const doubles: MockedHttpTransport[] = [];
  const createTransport = (given: HttpTransportOptions): HttpTransport => {
    const double = createChurchToolsDouble({
      token: given.token,
      origin: given.origin,
      logger: given.logger,
    });
    open.push(double);
    doubles.push(double);
    const login = (): Record<string, string> => ({
      authorization: `Login ${wiki.accepted.value}`,
    });
    double
      .intercept({
        path: '/api/wiki/categories',
        method: 'GET',
        headers: login(),
      })
      .reply((request) => {
        sawRequest(request);
        return {
          statusCode: 200,
          data: JSON.stringify({ data: wiki.categories }),
          responseOptions: json,
        };
      })
      .persist();
    double
      .intercept({
        path: (path: string) => path.split('?')[0] === '/api/wiki/pages',
        method: 'GET',
        headers: login(),
      })
      .reply((request) => {
        sawRequest(request);
        const params = new URL(request.path, doubleOrigin).searchParams;
        const category = Number(params.get('wiki_category_ids[]'));
        const page = Number(params.get('page') ?? '1');
        const limit = Number(params.get('limit') ?? '25');
        const all = wiki.pages.filter((entry) => entry.categoryId === category);
        const data = all
          .slice((page - 1) * limit, page * limit)
          .map((entry) => ({
            guid: entry.guid,
            title: entry.title,
            isMarkdown: true,
            version: 1,
          }));
        return {
          statusCode: wiki.pagesStatus,
          data: JSON.stringify({
            data,
            meta: {
              count: data.length,
              pagination: {
                total: all.length,
                limit,
                current: page,
                lastPage: Math.max(1, Math.ceil(all.length / limit)),
              },
            },
          }),
          responseOptions: json,
        };
      })
      .persist();
    double
      .intercept({ path: () => true, method: 'GET' })
      .reply((request) => {
        sawRequest(request);
        return { statusCode: 401, data: '{}', responseOptions: json };
      })
      .persist();
    return double.transport;
  };

  const run = async (
    call: {
      readonly routine?: string;
      readonly credential?: string;
      readonly cut?: boolean;
    } = {},
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logs: string[] = [];
    const output: Output = {
      stdout: (text) => {
        stdout.push(text);
        return call.cut !== true;
      },
      stderr: (text) => {
        stderr.push(text);
        return true;
      },
    };
    const decoder = new TextDecoder();
    const code = await initPolicy({
      environment,
      execArgv: [],
      interactive: false,
      routine: call.routine ?? routineId,
      credential: call.credential ?? 'berichte',
      output,
      writeSync: (_fd, buffer, offset, length) => {
        logs.push(decoder.decode(buffer.subarray(offset, offset + length)));
        return length;
      },
      createTransport,
    });
    return { code, stdout, stderr, logs };
  };

  // The token of every request, as the double saw it.
  const authorizations = (): readonly string[] => wiki.seen;

  // The lines of the audit files of the command.
  const auditLines = (): readonly Record<string, unknown>[] => {
    const folder = join(stateDir, 'audit');
    return readdirSync(folder)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) =>
        readFileSync(join(folder, name), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
  };

  return {
    base,
    stateDir,
    tokensDir,
    routinesDir,
    configDir,
    environment,
    serverCanary,
    accountToken,
    runnerToken,
    wiki,
    doubles,
    run,
    authorizations,
    auditLines,
  };
};

const entryLines = (maxPerDay: number, page = guid): readonly string[] => [
  `- routine: "${routineId}"`,
  '  credential: "berichte"',
  `  target: { kind: wiki_page, categoryId: 7, guid: "${page}", name: "${pageTitle}" }`,
  `  tools: [${tool}]`,
  '  maxPerRun: 1',
  `  maxPerDay: ${String(maxPerDay)}`,
];

const comments = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.startsWith('#'));

describe('ecclium policy init --routine', () => {
  it('proposes the entry of the page with the account of the alias', async () => {
    const { run, authorizations, accountToken, serverCanary, runnerToken } =
      setup();
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.slice(-6)).toEqual(entryLines(2));
    expect(comments(result.stdout)).toHaveLength(4);
    // Every read with the account of the alias, none with the server's.
    expect(authorizations().length).toBeGreaterThanOrEqual(2);
    expect(
      authorizations().every(
        (value) => value === `Login ${accountToken.value}`,
      ),
    ).toBe(true);
    assertNoCanary(
      [result.stdout, result.stderr, result.logs],
      [accountToken, serverCanary, runnerToken],
      'the output',
    );
  });

  it('loads the configuration of the runner, which refuses the token of the server', async () => {
    const server = makeCanary('token');
    const { run, doubles } = setup({
      extra: { ECCLIUM_CHURCHTOOLS_TOKEN: server.value },
    });
    const result = await run();
    expect(result.code).toBe(78);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).toMatch(/ECCLIUM_CHURCHTOOLS_TOKEN/u);
    expect(doubles).toHaveLength(0);
    // And it requires the folder of the kill switches, as the runner does.
    const noStop = setup({ extra: { ECCLIUM_KILL_SWITCH_DIR: undefined } });
    const refused = await noStop.run();
    expect(refused.code).toBe(78);
    expect(refused.stderr.join('\n')).toMatch(
      /ECCLIUM_KILL_SWITCH_DIR›? ist für den Runner nicht gesetzt\./u,
    );
    expect(noStop.doubles).toHaveLength(0);
  });

  it('gives an entry that the runner then takes for the routine', async () => {
    const { run, environment, configDir, routinesDir } = setup();
    const result = await run();
    expect(result.code).toBe(0);
    // The entry added to a file of the policy, as the operator does.
    const policyFile = privateFile(
      join(configDir, 'policy.yaml'),
      [
        'schema: policy.v1',
        'interactive: { inquiriesTo: "Sekretariat" }',
        'unattended:',
        ...result.stdout,
        '',
      ].join('\n'),
    );
    const loaded = loadConfig({
      environment: { ...environment, ECCLIUM_POLICY_FILE: policyFile },
      transport: 'runner',
    });
    if (!loaded.ok) throw new Error('the policy with the entry is invalid');
    const { policy } = loaded.config;
    expect(runCredentialOf(policy, routineId)).toEqual({
      ok: true,
      credential: 'berichte',
    });
    const routines = loadRoutines(routinesDir);
    if (!routines.ok) throw new Error('the routines do not load');
    const [routine] = routines.routines;
    if (routine === undefined) throw new Error('no routine');
    const catalog = createRunnerCatalog({ readOnly: false });
    const prepared = prepareRun(routine, {
      tool: (name) => describeRunTool(catalog, name),
      policy,
      models: new Set(['default']),
    });
    expect(prepared).toMatchObject({
      ok: true,
      run: {
        credential: 'berichte',
        redaction: 'strict',
        target: { target: { kind: 'wiki_page', guid } },
      },
    });
  });

  it('reads with the account of the alias and never with the token of the server', async () => {
    const { run, wiki, serverCanary, authorizations } = setup();
    wiki.accepted = serverCanary;
    const result = await run();
    expect(result.code).toBe(69);
    expect(result.stderr).toEqual([
      accountNamesFailedText('auth', 'categories'),
    ]);
    expect(result.stdout).toEqual([]);
    expect(authorizations()).not.toContain(`Login ${serverCanary.value}`);
  });

  it('writes each read into an audit file of its own, in the mode operator', async () => {
    const { run, auditLines } = setup();
    expect((await run()).code).toBe(0);
    const calls = auditLines().filter((line) => line['type'] === 'tool_call');
    expect(calls.map((line) => line['tool'])).toEqual([
      'ct_wiki_categories_list',
      'ct_wiki_pages_list',
    ]);
    expect(calls.every((line) => line['mode'] === 'operator')).toBe(true);
  });

  it('gives maxPerDay one more than the most triggers of a UTC day', async () => {
    const { run } = setup({
      routines: {
        [routineId]: routineValueOf(routineId, { schedule: '0 6,18 * * *' }),
      },
    });
    const result = await run();
    expect(result.stdout.at(-1)).toBe('  maxPerDay: 3');
  });

  it('matches the page in the normal form NFC and writes the name of the routine', async () => {
    const { run } = setup({
      routines: {
        [routineId]: routineValueOf(routineId, { page: 'Übersicht' }),
      },
      pages: [{ categoryId: 7, guid, title: 'U\u0308bersicht' }],
    });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `  target: { kind: wiki_page, categoryId: 7, guid: "${guid}", name: "Übersicht" }`,
    );
  });

  it('finds the page in a second category of the same name and writes its GUID in small letters', async () => {
    const { run } = setup({
      categories: [
        { id: 7, name: 'Berichte' },
        { id: 8, name: 'Berichte' },
        { id: 9, name: 'Archiv' },
      ],
      pages: [
        { categoryId: 7, guid: otherGuid, title: 'Andere Seite' },
        { categoryId: 8, guid: guid.toUpperCase(), title: pageTitle },
        { categoryId: 9, guid: otherGuid, title: pageTitle },
      ],
    });
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `  target: { kind: wiki_page, categoryId: 8, guid: "${guid}", name: "${pageTitle}" }`,
    );
  });

  describe('writes only comments', () => {
    it('for a category the account does not see', async () => {
      const { run } = setup({ categories: [{ id: 9, name: 'Archiv' }] });
      const result = await run();
      expect(result.code).toBe(0);
      expect(comments(result.stdout)).toEqual(result.stdout);
      expect(result.stdout.at(-1)).toContain('output.scope.category');
    });

    it('for a missing page, which a run never creates', async () => {
      const { run } = setup({ pages: [] });
      const result = await run();
      expect(result.code).toBe(0);
      expect(comments(result.stdout)).toEqual(result.stdout);
      expect(result.stdout.at(-1)).toContain('Ein Lauf legt keine Seite an');
    });

    it('for two pages with the name', async () => {
      const { run } = setup({
        pages: [
          { categoryId: 7, guid, title: pageTitle },
          { categoryId: 7, guid: otherGuid, title: pageTitle },
        ],
      });
      const result = await run();
      expect(result.code).toBe(0);
      expect(comments(result.stdout)).toEqual(result.stdout);
      expect(result.stdout.at(-1)).toContain('Mehr als eine Seite');
    });

    it('for a name the redaction changed, which never matches', async () => {
      const { run } = setup({
        pages: [{ categoryId: 7, guid, title: `${pageTitle}\u200b` }],
      });
      const result = await run();
      expect(result.code).toBe(0);
      const notes = comments(result.stdout).slice(-2);
      expect(notes[0]).toContain('Ein Lauf legt keine Seite an');
      expect(notes[1]).toContain('verändert an');
    });

    it('for a page whose name only the redaction made equal', async () => {
      // The note of the redaction would match a routine that names it.
      const { run } = setup({
        routines: {
          [routineId]: routineValueOf(routineId, {
            page: 'Bericht [ecclium: 1 hidden characters removed]',
          }),
        },
        pages: [{ categoryId: 7, guid, title: 'Bericht\u200b' }],
      });
      const result = await run();
      expect(result.code).toBe(0);
      expect(comments(result.stdout)).toEqual(result.stdout);
      expect(result.stdout.at(-1)).toContain('verändert an');
    });

    it('for a category whose name only the redaction made equal', async () => {
      const { run } = setup({
        routines: {
          [routineId]: routineValueOf(routineId, {
            category: 'Berichte [ecclium: 1 hidden characters removed]',
          }),
        },
        categories: [{ id: 7, name: 'Berichte\u200b' }],
      });
      const result = await run();
      expect(result.code).toBe(0);
      const notes = comments(result.stdout).slice(-2);
      expect(notes[0]).toContain('output.scope.category');
      expect(notes[1]).toContain('verändert an');
    });

    it('for the page in two categories of the same name', async () => {
      const { run } = setup({
        categories: [
          { id: 7, name: 'Berichte' },
          { id: 8, name: 'Berichte' },
        ],
        pages: [
          { categoryId: 7, guid, title: pageTitle },
          { categoryId: 8, guid: otherGuid, title: pageTitle },
        ],
      });
      const result = await run();
      expect(result.code).toBe(0);
      expect(comments(result.stdout)).toEqual(result.stdout);
      expect(result.stdout.at(-1)).toContain('Mehr als eine Seite');
    });

    it('for a category with more pages than the command reads', async () => {
      const pages = Array.from({ length: 1001 }, (_, index) => ({
        categoryId: 7,
        guid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        title: index === 1000 ? pageTitle : `Seite ${String(index)}`,
      }));
      const { run, authorizations } = setup({ pages });
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.stdout.at(-1)).toContain("länger als die 1'000 Einträge");
      // The categories once, then the 40 pages of the list it reads.
      expect(authorizations()).toHaveLength(41);
    });
  });

  it('notes the entries of the policy in force, a wish for standard and checks', async () => {
    const { run, tokensDir } = setup({
      routines: {
        [routineId]: routineValueOf(routineId, { redaction: 'standard' }),
        'pruefung-test': checksValueOf('pruefung-test'),
      },
      policy: {
        schema: 'policy.v1',
        unattended: [
          {
            routine: routineId,
            credential: 'andere',
            target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
            tools: [tool],
            maxPerRun: 1,
            maxPerDay: 2,
          },
        ],
      },
    });
    // The configuration of the runner checks the file of every alias of
    // the policy, as the runner does before its first run.
    privateFile(
      join(tokensDir, 'ct_token_andere'),
      `${makeCanary('token').value}\n`,
    );
    const result = await run();
    expect(result.code).toBe(0);
    const notes = comments(result.stdout).slice(4);
    expect(notes[0]).toContain(
      'schon einen Eintrag für diese Routine, mit einem anderen Konto',
    );
    expect(notes[1]).toContain('modelRedaction: standard');
    expect(result.stdout.slice(-6)).toEqual(entryLines(2));
    const checks = await run({ routine: 'pruefung-test' });
    expect(checks.code).toBe(0);
    expect(comments(checks.stdout).at(-1)).toContain('feste Prüfungen');
  });

  it('proposes nothing for a draft and asks ChurchTools nothing', async () => {
    const { run, doubles } = setup({
      routines: {
        [routineId]: routineValueOf(routineId, { target: 'draft' }),
      },
    });
    const result = await run();
    expect(result).toMatchObject({
      code: 0,
      stdout: [draftNeedsNoEntryText],
      stderr: [],
    });
    expect(doubles).toHaveLength(0);
  });

  describe('ends before a proposal', () => {
    it('with 64 for a routine the folder does not hold, without repeating it', async () => {
      const { run, doubles } = setup();
      const result = await run({ routine: 'unbekannt-test' });
      expect(result).toMatchObject({
        code: 64,
        stdout: [],
        stderr: [routineProposalTexts.routine_unknown],
      });
      expect(result.stderr.join('')).not.toContain('unbekannt-test');
      expect(doubles).toHaveLength(0);
    });

    it('with 78 without ECCLIUM_ROUTINES_DIR, a zone or a folder of state, which the configuration of the runner requires', async () => {
      for (const name of [
        'ECCLIUM_ROUTINES_DIR',
        'ECCLIUM_TIME_ZONE',
        'ECCLIUM_STATE_DIR',
      ] as const) {
        const { run, doubles } = setup({ extra: { [name]: undefined } });
        const result = await run();
        expect(result.code).toBe(78);
        expect(result.stdout).toEqual([]);
        expect(result.stderr.join('\n')).toMatch(
          new RegExp(`${name}›? ist für den Runner nicht gesetzt\\.`, 'u'),
        );
        expect(doubles).toHaveLength(0);
      }
    });

    it('with 66 when the folder of the routines is missing, 78 for a routine that does not load', async () => {
      const missing = setup();
      rmSync(missing.routinesDir, { recursive: true });
      const gone = await missing.run();
      expect(gone.code).toBe(66);
      expect(gone.stderr).toEqual([
        routinesLoadText({ code: 'routines_dir', reason: 'missing' }),
      ]);
      const broken = setup();
      privateFile(join(broken.routinesDir, 'kaputt-test.yaml'), 'schema: [');
      const refused = await broken.run();
      expect(refused.code).toBe(78);
      expect(refused.stderr[0]).toContain('kaputt-test');
    });

    it('with 78 without the token file of the alias or its folder', async () => {
      const without = setup();
      const missing = await without.run({ credential: 'andere' });
      expect(missing).toMatchObject({
        code: 78,
        stdout: [],
        stderr: [accountText('token_file_missing')],
      });
      expect(without.doubles).toHaveLength(0);
      // Without the folder the configuration of the runner refuses first.
      const unset = setup({
        extra: { ECCLIUM_RUNNER_TOKENS_DIR: undefined },
      });
      const refused = await unset.run();
      expect(refused.code).toBe(78);
      expect(refused.stderr.join('\n')).toContain('ECCLIUM_RUNNER_TOKENS_DIR');
      expect(unset.doubles).toHaveLength(0);
    });

    it('with 69 when ChurchTools gives no list of pages', async () => {
      const { run, wiki } = setup();
      wiki.pagesStatus = 500;
      const result = await run();
      expect(result.code).toBe(69);
      expect(result.stdout).toEqual([]);
      expect(result.stderr[0]).toContain('Seiten der Kategorie');
    });

    it('with 74 when the proposal does not reach stdout whole', async () => {
      const { run } = setup();
      const result = await run({ cut: true });
      expect(result.code).toBe(74);
      expect(result.stdout).toHaveLength(1);
      expect(result.stderr).toEqual([outputCutText]);
    });

    it('with 78 for an invalid configuration', async () => {
      const { run } = setup({
        extra: { ECCLIUM_TIME_ZONE: 'europe/zurich' },
      });
      const result = await run();
      expect(result.code).toBe(78);
      expect(result.stdout).toEqual([]);
    });
  });
});
