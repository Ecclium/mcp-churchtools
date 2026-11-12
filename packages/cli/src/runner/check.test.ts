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

import {
  type ConfigSources,
  loadConfig,
  type Transport,
} from '@ecclium/mcp-churchtools-core';
import {
  assertNoCanary,
  doubleModelEndpoint,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { exitCodes } from '../exit-codes.js';
import { checkRunnerConfig } from './check.js';
import { modelKeyText, refusedText, runnerStartTexts } from './texts.js';

// `ecclium config check --runner` over real temporary folders and the
// catalog of the runner, with the read tools of the core: it loads the
// configuration of the kind runner, the routines and their preparation,
// asks neither ChurchTools nor a model, and ends with its own line. All
// data are made up.

const validText =
  'Die Konfiguration des Runners ist gültig. ChurchTools und die Modelle wurden nicht angefragt. Probieren Sie eine Routine mit ‹ecclium run-once <Routine> --preview› aus: Die Vorschau liest und fragt das Modell der Routine, falls sie eines hat, schreibt aber nichts.';
const invalidText =
  'Mit dieser Konfiguration startet der Runner nicht, oder eine Routine startet nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check --runner›.';

const wikiRoutine = 'wochen-bericht';
const draftRoutine = 'termin-entwurf';

const template = [
  '### Termine {{period}}',
  '',
  '{{#termine}}',
  '- {{datum}}: {{titel}}',
  '{{/termine}}',
  '',
].join('\n');

/** What a routine of a test differs in. */
interface RoutineOptions {
  readonly target?: 'wiki' | 'draft';
  readonly tool?: string;
  /** The checks of the core in place of inputs and a model. */
  readonly checks?: boolean;
}

const checksTemplate = [
  '### Pflege {{period}}',
  '',
  '{{#stalePages}}',
  '- {{page}} ({{category}}), {{changed}}',
  '{{/stalePages}}',
  '{{#brokenLinks}}',
  '- {{page}}: {{link}}',
  '{{/brokenLinks}}',
  '',
].join('\n');

// A routine that reads the events with the read tool of the core.
const routineValueOf = (id: string, options: RoutineOptions = {}) => ({
  schema: 'routine.v1',
  id,
  schedule: '0 6 * * MON',
  ...(options.checks === true ? checksOf() : modelOf(id, options)),
  template: `templates/${id}.md`,
  output:
    options.target === 'draft'
      ? { target: 'draft', channel: 'file', idempotencyKey: `${id}:{isoWeek}` }
      : {
          target: 'wiki',
          tool: 'ct_wiki_page_append_section',
          scope: { category: 'Berichte', page: 'Termine' },
          idempotencyKey: `${id}:{isoWeek}`,
        },
  notify: [{ channel: 'stdout' }],
});

const checksOf = () => ({
  checks: [
    { check: 'stalePages', olderThanDays: 365, maxItems: 20 },
    { check: 'brokenLinks', maxItems: 20 },
  ],
});

const modelOf = (id: string, options: RoutineOptions) => ({
  inputs: [
    {
      name: 'termine',
      tool: options.tool ?? 'ct_events_list',
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
          fields: {
            datum: { type: 'date' },
            titel: { type: 'text', maxLength: 80 },
          },
        },
      },
    },
  },
});

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

/** What a test sets up differently. */
interface SetupOptions {
  readonly routines?: Readonly<Record<string, RoutineOptions>>;
  readonly extra?: Readonly<Record<string, string | undefined>>;
  /** Further entries of the unattended part of the policy. */
  readonly entries?: readonly Record<string, unknown>[];
  /** The mode of the file of the key of the model, 600 by default. */
  readonly modelKeyMode?: number;
}

const setup = (options: SetupOptions = {}) => {
  // A canary in the name of every folder and in each token and key file,
  // so that a path or a secret in the report would show.
  const pathCanary = makeCanary('token');
  const base = mkdtempSync(
    join(tmpdir(), `ecclium-runner-check-${pathCanary.cores[0] ?? ''}-`),
  );
  cleanup.push(base);
  const stateDir = privateDir(join(base, 'state'));
  privateDir(join(stateDir, 'stop'));
  const keysDir = privateDir(join(base, 'keys'));
  const tokensDir = privateDir(join(base, 'tokens'));
  const configDir = privateDir(join(base, 'config'));
  const routinesDir = privateDir(join(base, 'routines'));
  privateDir(join(routinesDir, 'prompts'));
  privateDir(join(routinesDir, 'templates'));
  const runnerToken = makeCanary('token');
  const accountToken = makeCanary('token');
  const modelKey = makeCanary('token');
  privateFile(join(tokensDir, 'ct_token_runner'), `${runnerToken.value}\n`);
  privateFile(join(tokensDir, 'ct_token_berichte'), `${accountToken.value}\n`);
  const modelKeyFile = privateFile(
    join(configDir, 'model-key'),
    `${modelKey.value}\n`,
  );
  // A key made from a seed instead of written out, so that no secret
  // scanner reads it as a leaked one.
  const markerFile = privateFile(
    join(configDir, 'marker-key'),
    `${createHash('sha256').update('runner-check-marker').digest('hex')}\n`,
  );
  // The key of the pseudonyms, which every routine at the level strict to
  // its model needs.
  const pseudonymFile = privateFile(
    join(configDir, 'pseudonym-key'),
    `${createHash('sha256').update('runner-check-pseudonym').digest('hex')}\n`,
  );
  // JSON is YAML, so the loaders read these files as they are.
  const policyFile = privateFile(
    join(configDir, 'policy.json'),
    JSON.stringify({
      schema: 'policy.v1',
      interactive: { inquiriesTo: 'Sekretariat' },
      unattended: [
        {
          routine: wikiRoutine,
          credential: 'berichte',
          modelRedaction: 'standard',
          target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 5,
        },
        ...(options.entries ?? []),
      ],
    }),
  );
  if (options.modelKeyMode !== undefined) {
    chmodSync(modelKeyFile, options.modelKeyMode);
  }
  const providersFile = privateFile(
    join(configDir, 'providers.json'),
    JSON.stringify({
      schema: 'providers.v1',
      providers: [
        {
          alias: 'default',
          vendor: 'example',
          model: 'example-model-1',
          hostingCountry: 'CH',
          endpoint: doubleModelEndpoint,
          structuredOutput: true,
          apiKeyFile: modelKeyFile,
        },
      ],
    }),
  );
  for (const [id, routine] of Object.entries(
    options.routines ?? {
      [wikiRoutine]: {},
      [draftRoutine]: { target: 'draft' },
    },
  )) {
    privateFile(
      join(routinesDir, `${id}.yaml`),
      JSON.stringify(routineValueOf(id, routine)),
    );
    privateFile(join(routinesDir, 'prompts', `${id}.md`), 'Fasse zusammen.\n');
    privateFile(
      join(routinesDir, 'templates', `${id}.md`),
      routine.checks === true ? checksTemplate : template,
    );
  }
  const environment: Record<string, string | undefined> = {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_TIME_ZONE: 'Europe/Zurich',
    ECCLIUM_POLICY_FILE: policyFile,
    ECCLIUM_ROUTINES_DIR: routinesDir,
    ECCLIUM_STATE_DIR: stateDir,
    ECCLIUM_RUNNER_TOKENS_DIR: tokensDir,
    ECCLIUM_PROVIDERS_FILE: providersFile,
    ECCLIUM_READ_ONLY: 'false',
    ECCLIUM_KEYS_DIR: keysDir,
    ECCLIUM_MARKER_KEY_FILE: markerFile,
    ECCLIUM_PSEUDONYM_KEY_FILE: pseudonymFile,
    ECCLIUM_DRAFTS_DIR: join(base, 'drafts'),
  };
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) Reflect.deleteProperty(environment, name);
    else environment[name] = value;
  }

  const check = (showValues = false) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const transports: Transport[] = [];
    const code = checkRunnerConfig({
      environment,
      execArgv: [],
      showValues,
      output: {
        stdout: (line) => stdout.push(line) > 0,
        stderr: (line) => stderr.push(line) > 0,
      },
      // The real loader, which notes the kind it was asked for.
      load: (sources: ConfigSources) => {
        transports.push(sources.transport);
        return loadConfig(sources);
      },
    });
    assertNoCanary(
      [stdout, stderr],
      [pathCanary, runnerToken, accountToken, modelKey],
      'the report',
    );
    return { code, stdout, stderr, transports };
  };
  return { check };
};

describe('ecclium config check --runner', () => {
  it('lists every routine that starts and ends with the line of the runner, not with ct_whoami', () => {
    const { check } = setup();
    const { code, stdout, stderr, transports } = check();
    expect(code).toBe(exitCodes.ok);
    expect(stderr).toEqual([]);
    expect(transports).toEqual(['runner']);
    expect(stdout[0]).toMatch(/^Prüfung der Konfiguration für den Betrieb /u);
    expect(stdout).toContain('Routinen, die starten: 2');
    // In the order of their IDs, without any value of ChurchTools.
    expect(stdout).toContain(
      `  - ‹${draftRoutine}›: Zeitplan ‹0 6 * * MON›, Entwurf über den Kanal ‹file›, eigenes Konto des Runners, Modell ‹default›, Maskierung zum Modell ‹strict›`,
    );
    expect(stdout).toContain(
      `  - ‹${wikiRoutine}›: Zeitplan ‹0 6 * * MON›, Abschnitt im Wiki, Konto ‹berichte›, Modell ‹default›, Maskierung zum Modell ‹standard›`,
    );
    const at = (id: string): number =>
      stdout.findIndex((line) => line.startsWith(`  - ‹${id}›`));
    expect(at(draftRoutine)).toBeGreaterThan(0);
    expect(at(draftRoutine)).toBeLessThan(at(wikiRoutine));
    expect(stdout.at(-1)).toBe(validText);
    expect(stdout.join('\n')).not.toContain('ct_whoami');
  });

  it('says so for a single routine', () => {
    const { check } = setup({
      routines: { [draftRoutine]: { target: 'draft' } },
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain('Routinen, die starten: 1');
  });

  it('names a routine that does not start with its code and field, and ends with 78', () => {
    const { check } = setup({
      routines: {
        [wikiRoutine]: {},
        'kaputt-test': { target: 'draft', tool: 'ct_unbekannt' },
      },
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toContain('Routinen, die starten: 1');
    expect(stdout).toContain(
      `  - ${refusedText({ routineId: 'kaputt-test', code: 'run_tool_unknown', field: 'inputs[0].tool' })}`,
    );
    expect(stdout.at(-1)).toBe(invalidText);
  });

  it('names a tool the catalog of the runner holds but no routine may rely on', () => {
    // The calendars, which are no stable read tool for routines.
    const { check } = setup({
      routines: {
        'kalender-test': { target: 'draft', tool: 'ct_calendars_list' },
      },
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toContain(
      `  - ${refusedText({ routineId: 'kalender-test', code: 'run_tool_unfit', field: 'inputs[0].tool' })}`,
    );
  });

  it('lists a routine with the checks of the core without a model, a key of the pseudonyms or providers', () => {
    const { check } = setup({
      routines: { 'pflege-test': { checks: true } },
      entries: [
        {
          routine: 'pflege-test',
          credential: 'runner',
          target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
          tools: ['ct_wiki_page_append_section'],
          maxPerRun: 1,
          maxPerDay: 2,
        },
      ],
      extra: {
        ECCLIUM_PSEUDONYM_KEY_FILE: undefined,
        ECCLIUM_PROVIDERS_FILE: undefined,
      },
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.ok);
    expect(stdout).toContain(
      '  - ‹pflege-test›: Zeitplan ‹0 6 * * MON›, Abschnitt im Wiki, Konto ‹runner›, ohne Modell, mit den Prüfungen ‹stalePages› und ‹brokenLinks›',
    );
    expect(stdout.at(-1)).toBe(validText);
  });

  it('names a routine at the level strict without the key of the pseudonyms', () => {
    const { check } = setup({
      extra: { ECCLIUM_PSEUDONYM_KEY_FILE: undefined },
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    // The draft routine has no entry, so it reads at strict; the wiki
    // routine's entry allows standard.
    expect(stdout).toContain(
      `  - ${refusedText({ routineId: draftRoutine, code: 'runner_pseudonym_key_missing' })}`,
    );
    expect(stdout.join('\n')).not.toContain(`routineId: ${wikiRoutine}`);
    expect(stdout.at(-1)).toBe(invalidText);
  });

  it('stops on two accounts for one routine before any other problem of it', () => {
    // The draft routine names a tool that does not exist and has entries
    // with two accounts: the accounts stop the whole runner (ADR 0033).
    const entryOf = (credential: string, id: number) => ({
      routine: draftRoutine,
      credential,
      target: { kind: 'wiki_category', id, name: `Kategorie ${String(id)}` },
      tools: ['ct_wiki_page_append_section'],
      maxPerRun: 1,
      maxPerDay: 5,
    });
    const { check } = setup({
      routines: {
        [wikiRoutine]: {},
        [draftRoutine]: { target: 'draft', tool: 'ct_nope' },
      },
      entries: [entryOf('berichte', 8), entryOf('runner', 9)],
    });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toContain(runnerStartTexts.credential_mixed(draftRoutine));
    expect(stdout.join('\n')).not.toContain('run_tool_unknown');
  });

  it('names the model whose key file a run could not use', () => {
    const { check } = setup({ modelKeyMode: 0o644 });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toContain(
      `  - ${modelKeyText('default', 'token_file_mode')}`,
    );
    expect(stdout.at(-1)).toBe(invalidText);
  });

  it('ends with 78 and the problems of an invalid configuration, before any routine', () => {
    const { check } = setup({ extra: { ECCLIUM_TIME_ZONE: undefined } });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout.join('\n')).toContain('ECCLIUM_TIME_ZONE');
    expect(stdout.join('\n')).not.toContain('Routinen, die starten');
    expect(stdout.at(-1)).toBe(invalidText);
  });

  it('ends with 78 when a routine into the wiki meets a configuration that only reads', () => {
    const { check } = setup({ extra: { ECCLIUM_READ_ONLY: 'true' } });
    const { code, stdout } = check();
    expect(code).toBe(exitCodes.invalidConfig);
    expect(stdout).toContain(runnerStartTexts.read_only_wiki(wikiRoutine));
    expect(stdout.at(-1)).toBe(invalidText);
  });
});
