import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type { TenantAssignment } from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from '../core-plugin.js';
import { maxListedRights } from './whoami.js';

// ct_whoami runs through the pipeline of the core on the double of
// ChurchTools, as the server runs it: catalog, input check, read access,
// output check, redaction and audit, with requests through the real
// transport. Core does not export its audit sink and line writer, so the
// test brings fakes typed from the options of the pipeline. Canaries stand
// in the token, in both names and in the e-mail address of the account.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
const [firstName = '', lastName = ''] = canary.name.cores;
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const whoamiPath = '/api/whoami?only_allow_authenticated=true';
const permissionsPath = '/api/permissions/global';
const json = { headers: { 'content-type': 'application/json' } };
const maskedEmail = `${canary.email.value.charAt(0)}***@example.org`;
const tooManyRights =
  'The account holds more rights than ct_whoami lists. Give the service account only the rights its tools need.';

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const setup = () => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const writer: LineWriter = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const audit: AuditSink = Object.freeze({
    record: (draft: AuditDraft) => {
      drafts.push(draft);
      return true;
    },
    hasFile: false,
    ready: () => false,
    failures: () => 0,
  });
  const clock = Object.freeze({ now: Object.freeze(() => 0) });
  const pipeline = createToolPipeline({
    catalog: createToolCatalog({
      core: createCorePlugin({ searchTools: false }),
      plugins: [],
      readOnly: true,
    }),
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
  });
  // An account that may not see persons gets its own person without the
  // e-mail, so withEmail false leaves the key out.
  const answerWhoami = (status = 200, withEmail = true): void => {
    double.intercept({ path: whoamiPath, method: 'GET' }).reply(
      status,
      JSON.stringify({
        data: {
          id: 7,
          guid: '00000000-0000-0000-0000-000000000007',
          firstName,
          lastName,
          ...(withEmail ? { email: canary.email.value } : {}),
        },
      }),
      json,
    );
  };
  const answerPermissions = (status: number, data: unknown): void => {
    double
      .intercept({ path: permissionsPath, method: 'GET' })
      .reply(status, JSON.stringify({ data }), json);
  };
  const call = (input: unknown = {}) =>
    pipeline.call('ct_whoami', input, request());
  const paths = (): string[] => double.calls().map((sent) => sent.path);
  return {
    double,
    lines,
    drafts,
    answerWhoami,
    answerPermissions,
    call,
    paths,
  };
};

// `count` rights of one module, each set to true.
const manyRights = (count: number): Record<string, true> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `right ${String(index).padStart(3, '0')}`,
      true,
    ]),
  );

describe('ct_whoami', () => {
  it('returns null for the e-mail address of an account that does not see it', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami(200, false);
    answerPermissions(200, { churchwiki: { view: true } });
    const outcome = await call();
    expect(outcome.ok && outcome.data).toMatchObject({
      id: 7,
      email: null,
      rights: {
        status: 'known',
        modules: [{ module: 'churchwiki', rights: [{ right: 'view' }] }],
      },
    });
  });

  it('returns the account and its set rights by module, sorted by code units', async () => {
    const { answerWhoami, answerPermissions, call, paths } = setup();
    answerWhoami();
    answerPermissions(200, {
      churchwiki: { view: true, edit: false, 'view category': [12, 0, 5] },
      churchdb: { view: false, 'view alldata': [] },
      churchcal: { 'view category': [3] },
      'X-custom': { view: true },
    });
    const outcome = await call();
    expect(outcome.ok && outcome.data).toEqual({
      id: 7,
      firstName,
      lastName,
      // Masked by the pipeline through the class of the field.
      email: maskedEmail,
      rights: {
        status: 'known',
        // Capitals come before small letters in code units, unlike in the
        // order of a locale. Rights that are false or an empty list stay
        // out, and ID 0 stays in.
        modules: [
          { module: 'X-custom', rights: [{ right: 'view' }] },
          {
            module: 'churchcal',
            rights: [{ right: 'view category', ids: [3], idCount: 1 }],
          },
          {
            module: 'churchwiki',
            rights: [
              { right: 'view' },
              { right: 'view category', ids: [0, 5, 12], idCount: 3 },
            ],
          },
        ],
      },
    });
    expect(paths()).toEqual(['/api/whoami', permissionsPath]);
  });

  it('lists the lowest IDs of a right in ascending order and how many it has', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami();
    const eleven = Array.from({ length: 11 }, (_, index) => (11 - index) * 10);
    const ten = Array.from({ length: 10 }, (_, index) => 10 - index);
    answerPermissions(200, { churchwiki: { edit: eleven, view: ten } });
    const outcome = await call();
    expect(outcome.ok && outcome.data.rights).toEqual({
      status: 'known',
      modules: [
        {
          module: 'churchwiki',
          rights: [
            {
              right: 'edit',
              ids: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
              idCount: 11,
            },
            {
              right: 'view',
              ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              idCount: 10,
            },
          ],
        },
      ],
    });
  });

  it('lists an account with 150 set rights', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami();
    answerPermissions(200, {
      churchdb: manyRights(100),
      churchwiki: manyRights(50),
    });
    const outcome = await call();
    expect(outcome.ok).toBe(true);
    const listed = outcome.ok
      ? (outcome.data.rights as { modules: { rights: unknown[] }[] }).modules
      : [];
    expect(listed.flatMap((entry) => entry.rights)).toHaveLength(
      maxListedRights,
    );
  });

  it('refuses an account with more than 150 set rights with a fixed sentence', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami();
    answerPermissions(200, {
      churchdb: manyRights(100),
      churchwiki: { ...manyRights(50), 'view category': [0] },
    });
    const outcome = await call();
    expect(!outcome.ok && outcome.error.code).toBe('upstream');
    expect(!outcome.ok && outcome.error.message).toBe(tooManyRights);
  });

  it('marks rights of an unknown structure as unknown', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami();
    answerPermissions(200, { churchwiki: { view: 'yes' } });
    const outcome = await call();
    expect(outcome.ok && outcome.data.rights).toEqual({
      status: 'unknown',
      modules: null,
    });
  });

  it('asks for the rights only after ChurchTools accepted the token', async () => {
    const { answerWhoami, answerPermissions, call, paths } = setup();
    answerWhoami(401);
    answerPermissions(200, { churchwiki: { view: true } });
    const outcome = await call();
    expect(!outcome.ok && outcome.error.code).toBe('auth');
    expect(paths()).toEqual(['/api/whoami']);
  });

  it('ends with the error of a failed request for the rights', async () => {
    const { answerWhoami, answerPermissions, call } = setup();
    answerWhoami();
    answerPermissions(500, {});
    const outcome = await call();
    expect(!outcome.ok && outcome.error.code).toBe('upstream');
  });

  it('refuses an argument the model made up before any request', async () => {
    const { call, paths } = setup();
    const outcome = await call({ verbose: true });
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(paths()).toEqual([]);
  });

  it('leaves token, names and e-mail address out of log and audit', async () => {
    const { double, lines, drafts, answerWhoami, answerPermissions, call } =
      setup();
    answerWhoami();
    answerPermissions(200, { churchwiki: { view: true } });
    const outcome = await call();
    // The token reached ChurchTools and the names reached the result, so
    // the checks below prove something.
    assertPlanted(double.calls(), [canary.token], 'request');
    expect(
      outcome.ok && [outcome.data.firstName, outcome.data.lastName],
    ).toEqual([firstName, lastName]);
    assertNoCanary(outcome, [canary.token, canary.email], 'result');
    expect(lines.length).toBeGreaterThan(0);
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_whoami', outcome: 'ok' }),
    ]);
    assertNoCanary([lines, drafts], canary.all, 'log and audit');
  });
});
