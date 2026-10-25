import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import type {
  Plugin,
  ReadApi,
  TenantAssignment,
  TenantContext,
  ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  groupAtHighestLevel,
  groupMembersAtHighestLevel,
  makeCanaries,
  personAtHighestLevel,
  personGroupsAtHighestLevel,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorePlugin } from './core-plugin.js';
import { groupsGetTool, noGroupDetails } from './groups/get.js';
import {
  emptyMemberPageMoreFollow,
  groupsGetMembersTool,
  noMemberListed,
  pastLastMemberPage,
} from './groups/members.js';
import { personsGetTool } from './persons/get.js';
import {
  moreGroupsListed,
  noGroupListed,
  personsGetGroupsTool,
} from './persons/groups.js';
import {
  groupNotFound,
  groupRefused,
  personNotFound,
  personRefused,
} from './persons/rights.js';

// The four reads by ID of ADR 0064 run through the pipeline of the core on
// the double of ChurchTools, as the server runs them, with the toolset
// persons and an audit file. The three layers are the client, which reads
// only the fields of its schema, the tool, which declares and copies only
// them, and the pipeline, which lets nothing through that the output
// schema does not declare.

type AuditSink = ToolPipelineOptions['audit'];
type AuditDraft = Parameters<AuditSink['record']>[0];
type LineWriter = ToolPipelineOptions['logging']['writer'];

const canary = makeCanaries();
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

const json = { headers: { 'content-type': 'application/json' } };
const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

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

const coreCatalog = (): ToolCatalog =>
  createToolCatalog({
    core: createCorePlugin(),
    toolsets: new Set(['persons'] as const),
    plugins: [],
    readOnly: true,
  });

const setup = (catalog: ToolCatalog = coreCatalog()) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const lines: string[] = [];
  const drafts: AuditDraft[] = [];
  const quota = new Map<string, number>();
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
    hasFile: true,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(quota),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => 0) }),
    logging: { writer, minLevel: 'debug' },
  });
  const call = (name: string, input: unknown) =>
    pipeline.call(name, input, request());
  return { double, lines, drafts, quota, call };
};

// A text in the data envelope: the markers with the boundary of the call
// around it.
const enveloped = (text: string): unknown =>
  expect.stringMatching(
    new RegExp(
      `^<<data-[^>]+>>${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}<</data-[^>]+>>$`,
      'u',
    ),
  ) as unknown;

const person = { id: 7, firstName: 'Person', lastName: 'A', isArchived: true };
const membership = (index: number) => ({
  groupId: index,
  groupName: `Gruppe ${String(index)}`,
  groupTypeRoleId: 8,
  groupMemberStatus: 'active',
});
const member = (index: number) => ({
  personId: index,
  firstName: 'Person',
  lastName: `P${String(index)}`,
  groupTypeRoleId: 8,
  groupMemberStatus: 'active',
});
const details = {
  meetingTime: 'Dienstag, 19 Uhr',
  note: 'Notiz der Gruppe',
  maxMembers: 12,
  targetGroupId: 2,
  dateOfFoundation: '1950-03-01',
  endDate: null,
};

const viewAllData = { module: 'churchdb', right: 'view alldata' };
const viewGroups = { module: 'churchgroup', right: 'view groups of grouptype' };

describe('the three layers together', () => {
  it('let no field of a person at the highest level but the four reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = personAtHighestLevel(person);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/persons/7', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_persons_get', { personId: 7 });
    expect(outcome.ok && outcome.data).toEqual(person);
    assertNoCanary(outcome, answer.canaries, 'result');
    expect(lines.length).toBeGreaterThan(0);
    assertNoCanary(lines, answer.canaries, 'log');
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_persons_get', outcome: 'ok' }),
    ]);
    assertNoCanary(drafts, answer.canaries, 'audit');
  });

  it('let no field of the groups of a person but group, role and status reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = personGroupsAtHighestLevel([membership(3), membership(4)]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/persons/7/groups', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_persons_get_groups', { personId: 7 });
    expect(outcome.ok && outcome.data.groups).toEqual([
      { ...membership(3), groupName: enveloped('Gruppe 3') },
      { ...membership(4), groupName: enveloped('Gruppe 4') },
    ]);
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of a group at the highest level but name and the six details reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = groupAtHighestLevel({ id: 3, name: 'Gruppe A', details });
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/groups/3', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_groups_get', { groupId: 3 });
    expect(outcome.ok && outcome.data).toEqual({
      id: 3,
      name: enveloped('Gruppe A'),
      details: {
        ...details,
        meetingTime: enveloped('Dienstag, 19 Uhr'),
        note: enveloped('Notiz der Gruppe'),
      },
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of the members at the highest level but ID, names, role and status reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = groupMembersAtHighestLevel([member(1), member(2)], 1);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/groups/3/members'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_groups_get_members', { groupId: 3 });
    expect(outcome.ok && outcome.data).toEqual({
      groupId: 3,
      page: 1,
      members: [member(1), member(2)],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });
});

describe('ct_persons_get', () => {
  it.each([
    [404, { code: 'not_found', message: personNotFound }],
    [
      403,
      {
        code: 'permission',
        message: personRefused,
        missingRights: [viewAllData],
      },
    ],
  ])(
    'turns status %i into an error the model can act on',
    async (status, error) => {
      const { double, call } = setup();
      double
        .intercept({ path: '/api/persons/7', method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_persons_get', { personId: 7 });
      expect(!outcome.ok && outcome.error).toEqual(error);
    },
  );

  it.each([
    ['an ID 0', { personId: 0 }],
    ['an ID as text', { personId: '7' }],
    ['a broken ID', { personId: 7.5 }],
    ['a field it does not know', { personId: 7, personFields: ['email'] }],
    ['no ID', {}],
  ])('refuses %s before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call('ct_persons_get', input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });
});

describe('ct_persons_get_groups', () => {
  it('names the rights when no group is listed', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/persons/7/groups', method: 'GET' })
      .reply(200, personGroupsAtHighestLevel([]).body, json);
    const outcome = await call('ct_persons_get_groups', { personId: 7 });
    expect(outcome.ok && outcome.data).toEqual({
      personId: 7,
      groups: [],
      more: false,
      notice: noGroupListed,
    });
    expect(noGroupListed).toContain('"view alldata" in churchdb');
    expect(noGroupListed).toContain(
      '"view groups of grouptype" in churchgroup',
    );
  });

  it('gives 50 of 51 groups and says that there are more', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/persons/7/groups', method: 'GET' })
      .reply(
        200,
        personGroupsAtHighestLevel(
          Array.from({ length: 51 }, (_, index) => membership(index + 1)),
        ).body,
        json,
      );
    const outcome = await call('ct_persons_get_groups', { personId: 7 });
    expect(outcome.ok && outcome.data.groups).toHaveLength(50);
    expect(outcome.ok && [outcome.data.more, outcome.data.notice]).toEqual([
      true,
      moreGroupsListed,
    ]);
  });

  it('gives a group whose identifier is no plain whole number without ID', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/persons/7/groups', method: 'GET' })
      .reply(
        200,
        personGroupsAtHighestLevel([{ ...membership(3), groupId: 'g-3' }]).body,
        json,
      );
    const outcome = await call('ct_persons_get_groups', { personId: 7 });
    expect(outcome.ok && outcome.data.groups).toEqual([
      { ...membership(3), groupId: null, groupName: enveloped('Gruppe 3') },
    ]);
  });

  it.each([
    [404, { code: 'not_found', message: personNotFound }],
    [
      403,
      {
        code: 'permission',
        message: personRefused,
        missingRights: [viewAllData, viewGroups],
      },
    ],
  ])(
    'turns status %i into an error the model can act on',
    async (status, error) => {
      const { double, call } = setup();
      double
        .intercept({ path: '/api/persons/7/groups', method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_persons_get_groups', { personId: 7 });
      expect(!outcome.ok && outcome.error).toEqual(error);
    },
  );
});

describe('ct_groups_get', () => {
  it('names the security level of groups when ChurchTools sends no details', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/groups/3', method: 'GET' })
      .reply(
        200,
        groupAtHighestLevel({ id: 3, name: 'Gruppe A', details: null }).body,
        json,
      );
    const outcome = await call('ct_groups_get', { groupId: 3 });
    expect(outcome.ok && outcome.data).toEqual({
      id: 3,
      name: enveloped('Gruppe A'),
      details: null,
      notice: noGroupDetails,
    });
    expect(noGroupDetails).toContain('"security level group" in churchgroup');
  });

  it('passes null details on as null', async () => {
    const { double, call } = setup();
    const empty = {
      meetingTime: null,
      note: null,
      maxMembers: null,
      targetGroupId: null,
      dateOfFoundation: null,
      endDate: null,
    };
    double
      .intercept({ path: '/api/groups/3', method: 'GET' })
      .reply(
        200,
        groupAtHighestLevel({ id: 3, name: 'Gruppe A', details: empty }).body,
        json,
      );
    const outcome = await call('ct_groups_get', { groupId: 3 });
    expect(outcome.ok && [outcome.data.details, outcome.data.notice]).toEqual([
      empty,
      null,
    ]);
  });

  it.each([
    [404, { code: 'not_found', message: groupNotFound }],
    [
      403,
      {
        code: 'permission',
        message: groupRefused,
        missingRights: [viewGroups],
      },
    ],
  ])(
    'turns status %i into an error the model can act on',
    async (status, error) => {
      const { double, call } = setup();
      double
        .intercept({ path: '/api/groups/3', method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_groups_get', { groupId: 3 });
      expect(!outcome.ok && outcome.error).toEqual(error);
    },
  );
});

describe('ct_groups_get_members', () => {
  it('asks for page 1 with limit 50 when no page is given', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/groups/3/members'), method: 'GET' })
      .reply(200, groupMembersAtHighestLevel([member(1)], 2).body, json);
    const outcome = await call('ct_groups_get_members', { groupId: 3 });
    expect(outcome.ok && [outcome.data.page, outcome.data.more]).toEqual([
      1,
      true,
    ]);
    expect(double.calls()[0]?.searchParams).toEqual({
      page: '1',
      limit: '50',
    });
  });

  it.each([
    [1, 1, noMemberListed],
    [3, 2, pastLastMemberPage],
    [2, 5, emptyMemberPageMoreFollow],
  ])(
    'gives an empty page %i of %i pages the note that fits',
    async (page, lastPage, notice) => {
      const { double, call } = setup();
      double
        .intercept({ path: at('/api/groups/3/members'), method: 'GET' })
        .reply(200, groupMembersAtHighestLevel([], lastPage).body, json);
      const outcome = await call('ct_groups_get_members', { groupId: 3, page });
      expect(outcome.ok && outcome.data.notice).toBe(notice);
    },
  );

  it('counts every page against the read budget', async () => {
    const { double, quota, call } = setup();
    for (const lastPage of [2, 2]) {
      double
        .intercept({ path: at('/api/groups/3/members'), method: 'GET' })
        .reply(
          200,
          groupMembersAtHighestLevel([member(1)], lastPage).body,
          json,
        );
    }
    await call('ct_groups_get_members', { groupId: 3, page: 1 });
    await call('ct_groups_get_members', { groupId: 3, page: 2 });
    expect([...quota.values()]).toEqual([2]);
  });

  it.each([
    ['a page 0', { groupId: 3, page: 0 }],
    ['a page 1001', { groupId: 3, page: 1001 }],
    ['a limit it does not know', { groupId: 3, limit: 500 }],
  ])('refuses %s before any request', async (_, input) => {
    const { double, call } = setup();
    const outcome = await call('ct_groups_get_members', input);
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    expect(double.calls()).toEqual([]);
  });

  it.each([
    [404, { code: 'not_found', message: groupNotFound }],
    [
      403,
      {
        code: 'permission',
        message: groupRefused,
        missingRights: [viewGroups],
      },
    ],
  ])(
    'turns status %i into an error the model can act on',
    async (status, error) => {
      const { double, call } = setup();
      double
        .intercept({ path: at('/api/groups/3/members'), method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call('ct_groups_get_members', { groupId: 3 });
      expect(!outcome.ok && outcome.error).toEqual(error);
    },
  );
});

// The layer of the tools, without client and pipeline: whatever the read
// access hands them, they pass on only their fields.
describe('the layer of the tools', () => {
  const leak = makeCanaries();
  const ctx = {} as TenantContext;

  it('copies only the four fields of a person', async () => {
    const read = {
      person: () => Promise.resolve({ ...person, email: leak.email.value }),
    } as unknown as ReadApi;
    const result = await personsGetTool.execute({
      ctx,
      input: { personId: 7 },
      read,
    });
    expect(result).toEqual(person);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only group, role and status of a membership', async () => {
    const read = {
      personGroups: () =>
        Promise.resolve({
          groups: [{ ...membership(3), comment: leak.name.value }],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await personsGetGroupsTool.execute({
      ctx,
      input: { personId: 7 },
      read,
    });
    expect(result.groups).toEqual([membership(3)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only name and the six details of a group', async () => {
    const read = {
      group: () =>
        Promise.resolve({
          id: 3,
          name: 'Gruppe A',
          details: { ...details, weekday: leak.name.value },
          leaders: [leak.email.value],
        }),
    } as unknown as ReadApi;
    const result = await groupsGetTool.execute({
      ctx,
      input: { groupId: 3 },
      read,
    });
    expect(result).toEqual({
      id: 3,
      name: 'Gruppe A',
      details,
      notice: null,
    });
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only ID, names, role and status of a member', async () => {
    const read = {
      groupMembers: () =>
        Promise.resolve({
          members: [{ ...member(1), mobile: leak.phone.value }],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await groupsGetMembersTool.execute({
      ctx,
      input: { groupId: 3 },
      read,
    });
    expect(result.members).toEqual([member(1)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });
});

// The layer of the pipeline alone: a tool with the schemas of a read whose
// execute returns more than they declare, as a broken client and a broken
// tool together would. The pipeline drops every field the output schema
// does not declare.
describe('the layer of the pipeline', () => {
  const leak = makeCanaries();
  const leaky = (tool: ToolDefinition, result: unknown): ToolCatalog =>
    createToolCatalog({
      core: {
        name: '@ecclium/test-persons-groups',
        version: '0.0.0',
        register(host): undefined {
          host.addTool({ ...tool, execute: () => Promise.resolve(result) });
          return undefined;
        },
      } satisfies Plugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['persons'] as const),
    });

  it.each([
    [
      'ct_persons_get',
      personsGetTool,
      { personId: 7 },
      { ...person, email: leak.email.value, guid: leak.token.value },
      person,
    ],
    [
      'ct_persons_get_groups',
      personsGetGroupsTool,
      { personId: 7 },
      {
        personId: 7,
        groups: [{ ...membership(3), person: { name: leak.name.value } }],
        more: false,
        notice: null,
        meta: { count: leak.phone.value },
      },
      {
        personId: 7,
        groups: [{ ...membership(3), groupName: enveloped('Gruppe 3') }],
        more: false,
        notice: null,
      },
    ],
    [
      'ct_groups_get',
      groupsGetTool,
      { groupId: 3 },
      {
        id: 3,
        name: 'Gruppe A',
        details: { ...details, qrCodeCheckinAutomaticEmail: leak.email.value },
        notice: null,
        roles: [leak.name.value],
      },
      {
        id: 3,
        name: enveloped('Gruppe A'),
        details: {
          ...details,
          meetingTime: enveloped('Dienstag, 19 Uhr'),
          note: enveloped('Notiz der Gruppe'),
        },
        notice: null,
      },
    ],
    [
      'ct_groups_get_members',
      groupsGetMembersTool,
      { groupId: 3 },
      {
        groupId: 3,
        page: 1,
        members: [{ ...member(1), email: leak.email.value }],
        more: false,
        notice: null,
        total: leak.phone.value,
      },
      {
        groupId: 3,
        page: 1,
        members: [member(1)],
        more: false,
        notice: null,
      },
    ],
  ] as const)(
    'drops every field %s does not declare',
    async (name, tool, input, result, kept) => {
      const { lines, drafts, call } = setup(leaky(tool, result));
      const outcome = await call(name, input);
      expect(outcome.ok && outcome.data).toEqual(kept);
      assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
    },
  );
});

// A tool that declares less than the sensitivity special may not read
// persons or groups: its result would neither wait for its audit line nor
// be barred from running unattended (ADR 0028, ADR 0064).
describe('the read access of a tool below special', () => {
  it.each([
    ['ct_persons_get', personsGetTool, { personId: 7 }],
    ['ct_persons_get_groups', personsGetGroupsTool, { personId: 7 }],
    ['ct_groups_get', groupsGetTool, { groupId: 3 }],
    ['ct_groups_get_members', groupsGetMembersTool, { groupId: 3 }],
  ] as const)(
    'refuses %s with policy_denied before any request',
    async (name, tool, input) => {
      const plugin: Plugin = {
        name: '@ecclium/test-persons-groups',
        version: '0.0.0',
        register(host): undefined {
          host.addTool({
            ...(tool as unknown as ToolDefinition),
            meta: {
              ...tool.meta,
              sensitivity: 'personal',
              unattended: 'policy',
            },
          });
          return undefined;
        },
      };
      const { double, lines, call } = setup(
        createToolCatalog({
          core: plugin,
          plugins: [],
          readOnly: true,
          toolsets: new Set(['persons'] as const),
        }),
      );
      const outcome = await call(name, input);
      expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
      expect(double.calls()).toEqual([]);
      expect(lines.join('\n')).toContain('read_search_refused');
    },
  );
});
