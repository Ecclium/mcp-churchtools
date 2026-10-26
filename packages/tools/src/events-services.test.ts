import {
  createToolCatalog,
  createToolPipeline,
  loadConfig,
  type ToolCatalog,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  type AgendaItem,
  classify,
  type Plugin,
  type ReadApi,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  agendaAnswer,
  assertNoCanary,
  assertPlanted,
  type AssignmentFixture,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  eventAnswer,
  eventAssignmentsAnswer,
  type EventFixture,
  eventsAnswer,
  makeCanaries,
  type ServiceFixture,
  serviceGroupsAnswer,
  servicesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCorePlugin } from './core-plugin.js';
import {
  eventsGetAgendaTool,
  noAgendaItem,
  pastLastAgendaPage,
} from './events/agenda.js';
import { eventsGetTool } from './events/get.js';
import {
  eventsListTool,
  fewerDaysNeeded,
  invalidSpan,
  noEventListed,
  pastLastEventPage,
} from './events/list.js';
import {
  agendaNotFound,
  agendaRefused,
  eventNotFound,
  eventRefused,
} from './events/rights.js';
import {
  noAssignmentListed,
  pastLastAssignmentPage,
  servicesGetAssignmentsTool,
  someNamesWithheld,
} from './services/assignments.js';
import {
  noServiceListed,
  pastLastServicePage,
  servicesListTool,
} from './services/list.js';

// The five reads of events, agendas, services and assignments of ADR 0064
// run through the pipeline of the core on the double of ChurchTools, as the
// server runs them, with the toolset events and an audit file. The three
// layers are the client, which reads only the fields of its schema, the
// tool, which declares and copies only them, and the pipeline, which lets
// nothing through that the output schema does not declare.

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
    toolsets: new Set(['events'] as const),
    plugins: [],
    readOnly: true,
  });

const setup = (
  catalog: ToolCatalog = coreCatalog(),
  options: { readonly recorded?: boolean } = {},
) => {
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
      return options.recorded ?? true;
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

const entry = (index: number): EventFixture => ({
  id: index,
  name: `Event ${String(index)}`,
  startDate: '2026-10-25T09:00:00Z',
  endDate: '2026-10-25T10:30:00Z',
  isCanceled: false,
  calendarId: 8,
  calendarName: 'Kalender A',
});
const shownEntry = (index: number) => ({
  ...entry(index),
  name: enveloped(`Event ${String(index)}`),
  calendarName: enveloped('Kalender A'),
});
const details = {
  ...entry(2),
  note: 'Notiz des Events',
  description: 'Beschreibung des Events',
};
const item = (index: number, extra: Partial<AgendaItem> = {}): AgendaItem => ({
  position: index,
  type: 'normal',
  title: `Punkt ${String(index)}`,
  start: '2026-10-25T09:00:00Z',
  duration: 300,
  isBeforeEvent: false,
  note: null,
  song: null,
  ...extra,
});
const service = (
  id: number,
  extra: Partial<ServiceFixture> = {},
): ServiceFixture => ({
  id,
  name: `Dienst ${String(id)}`,
  serviceGroupId: 5,
  hidePersonName: false,
  ...extra,
});
const assignment = (
  serviceId: number,
  extra: Partial<AssignmentFixture> = {},
): AssignmentFixture => ({
  serviceId,
  isAccepted: true,
  agreed: true,
  personId: 1,
  firstName: 'Person',
  lastName: 'A',
  ...extra,
});

// The services and their groups, as the list and the assignments read
// them.
const replyServices = (
  double: ReturnType<typeof setup>['double'],
  services: readonly ServiceFixture[],
) => {
  const list = servicesAnswer(services);
  const groups = serviceGroupsAnswer([{ id: 5, name: 'Dienstgruppe A' }]);
  assertPlanted(JSON.parse(list.body), list.canaries, 'services');
  assertPlanted(JSON.parse(groups.body), groups.canaries, 'groups');
  double
    .intercept({ path: '/api/services', method: 'GET' })
    .reply(200, list.body, json);
  double
    .intercept({ path: '/api/servicegroups', method: 'GET' })
    .reply(200, groups.body, json);
  return [...list.canaries, ...groups.canaries];
};

const replyAssignments = (
  double: ReturnType<typeof setup>['double'],
  assignments: readonly AssignmentFixture[],
  services: readonly ServiceFixture[] = [service(11)],
) => {
  // The event, then the services; the groups of services are not read.
  const event = eventAssignmentsAnswer(assignments);
  const list = servicesAnswer(services);
  assertPlanted(JSON.parse(event.body), event.canaries, 'event');
  assertPlanted(JSON.parse(list.body), list.canaries, 'services');
  double
    .intercept({ path: '/api/events/2', method: 'GET' })
    .reply(200, event.body, json);
  double
    .intercept({ path: '/api/services', method: 'GET' })
    .reply(200, list.body, json);
  return [...event.canaries, ...list.canaries];
};

// One page of a list in a result: its entries, more and the notice, or
// false for a failed call.
const pageOf = (
  outcome: Awaited<ReturnType<ReturnType<typeof setup>['call']>>,
  key: string,
) => {
  if (!outcome.ok) return false;
  const data = outcome.data;
  return {
    entries: data[key] as readonly Readonly<Record<string, unknown>>[],
    more: data['more'],
    notice: data['notice'],
  };
};

const viewEvents = { module: 'churchservice', right: 'view events' };
const viewAgenda = { module: 'churchservice', right: 'view agenda' };

describe('the three layers together', () => {
  it('let no field of the list of events but the seven reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = eventsAnswer([entry(2), entry(3)]);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: at('/api/events'), method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_events_list', {
      from: '2026-10-25',
      to: '2026-10-31',
    });
    expect(outcome.ok && outcome.data).toEqual({
      from: '2026-10-25',
      to: '2026-10-31',
      page: 1,
      events: [shownEntry(2), shownEntry(3)],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
    expect(drafts).toEqual([
      expect.objectContaining({ tool: 'ct_events_list', outcome: 'ok' }),
    ]);
  });

  it('let no field of an event but the nine reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const answer = eventAnswer(details);
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_events_get', { eventId: 2 });
    expect(outcome.ok && outcome.data).toEqual({
      ...shownEntry(2),
      note: enveloped('Notiz des Events'),
      description: enveloped('Beschreibung des Events'),
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of an agenda but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const song = {
      songId: 2,
      arrangementId: 3,
      title: 'Lied A',
      arrangement: 'Standard',
    };
    const answer = agendaAnswer({
      name: 'Ablauf',
      isFinal: true,
      items: [item(1, { note: 'Notiz' }), item(2, { type: 'song', song })],
    });
    assertPlanted(JSON.parse(answer.body), answer.canaries, 'answer');
    double
      .intercept({ path: '/api/events/2/agenda', method: 'GET' })
      .reply(200, answer.body, json);
    const outcome = await call('ct_events_get_agenda', { eventId: 2 });
    expect(outcome.ok && outcome.data).toEqual({
      eventId: 2,
      page: 1,
      name: enveloped('Ablauf'),
      isFinal: true,
      items: [
        { ...item(1), title: enveloped('Punkt 1'), note: enveloped('Notiz') },
        {
          ...item(2, { type: 'song' }),
          title: enveloped('Punkt 2'),
          song: {
            ...song,
            title: enveloped('Lied A'),
            arrangement: enveloped('Standard'),
          },
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary(
      [outcome, lines, drafts],
      answer.canaries,
      'result, log, audit',
    );
  });

  it('let no field of the services but the declared ones reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const canaries = replyServices(double, [
      service(11),
      service(14, { hidePersonName: true, serviceGroupId: 9 }),
    ]);
    const outcome = await call('ct_services_list', {});
    expect(outcome.ok && outcome.data).toEqual({
      page: 1,
      services: [
        {
          id: 11,
          name: enveloped('Dienst 11'),
          serviceGroupId: 5,
          serviceGroupName: enveloped('Dienstgruppe A'),
          hidesNames: false,
        },
        {
          id: 14,
          name: enveloped('Dienst 14'),
          serviceGroupId: 9,
          serviceGroupName: null,
          hidesNames: true,
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary([outcome, lines, drafts], canaries, 'result, log, audit');
  });

  it('let no field of the assignments but service, states and the person reach result, log or audit', async () => {
    const { double, lines, drafts, call } = setup();
    const canaries = replyAssignments(double, [
      assignment(11),
      assignment(11, { isAccepted: false, personId: 3, lastName: 'C' }),
    ]);
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(outcome.ok && outcome.data).toEqual({
      eventId: 2,
      page: 1,
      assignments: [
        {
          serviceId: 11,
          serviceName: enveloped('Dienst 11'),
          isAccepted: true,
          agreed: true,
          person: { personId: 1, firstName: 'Person', lastName: 'A' },
        },
        {
          serviceId: 11,
          serviceName: enveloped('Dienst 11'),
          isAccepted: false,
          agreed: true,
          person: { personId: 3, firstName: 'Person', lastName: 'C' },
        },
      ],
      more: false,
      notice: null,
    });
    assertNoCanary([outcome, lines, drafts], canaries, 'result, log, audit');
  });
});

describe('ct_events_list', () => {
  it.each([
    ['32 days', '2026-10-01', '2026-11-01'],
    ['a last day before the first', '2026-10-25', '2026-10-24'],
    ['a day that does not exist', '2026-02-30', '2026-03-01'],
  ])(
    'refuses %s with a sentence that names the rule, before any request',
    async (_, from, to) => {
      const { double, call } = setup();
      const outcome = await call('ct_events_list', { from, to });
      expect(!outcome.ok && outcome.error).toEqual({
        code: 'validation',
        message: invalidSpan,
      });
      expect(double.calls()).toEqual([]);
    },
  );

  it('names the right when no event is listed', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: at('/api/events'), method: 'GET' })
      .reply(200, eventsAnswer([]).body, json);
    const outcome = await call('ct_events_list', {
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(outcome.ok && outcome.data.notice).toBe(noEventListed);
    expect(noEventListed).toContain('"view events" in churchservice');
  });

  it('pages through 50 events, 25 per call, and asks for fewer days when more follow', async () => {
    const { double, call } = setup();
    const answer = (count: number) =>
      eventsAnswer(
        Array.from({ length: count }, (_, index) => entry(index + 1)),
      ).body;
    for (const count of [50, 50, 51, 51, 30]) {
      double
        .intercept({ path: at('/api/events'), method: 'GET' })
        .reply(200, answer(count), json);
    }
    const days = { from: '2026-10-01', to: '2026-10-31' };
    const summary = [];
    for (const page of [1, 2, 1, 2, 2]) {
      const outcome = await call('ct_events_list', { ...days, page });
      const shown = pageOf(outcome, 'events');
      summary.push(
        shown && [
          shown.entries.length,
          shown.entries[0]?.['id'],
          shown.more,
          shown.notice,
        ],
      );
    }
    expect(summary).toEqual([
      [25, 1, true, null],
      [25, 26, false, null],
      [25, 1, true, null],
      [25, 26, false, fewerDaysNeeded],
      [5, 26, false, null],
    ]);
    double
      .intercept({ path: at('/api/events'), method: 'GET' })
      .reply(200, answer(10), json);
    const empty = await call('ct_events_list', { ...days, page: 2 });
    expect(empty.ok && [empty.data.events, empty.data.notice]).toEqual([
      [],
      pastLastEventPage,
    ]);
  });

  it('refuses page 3 with a validation error', async () => {
    const { call } = setup();
    const outcome = await call('ct_events_list', {
      from: '2026-10-25',
      to: '2026-10-25',
      page: 3,
    });
    expect(!outcome.ok && outcome.error.code).toBe('validation');
  });
});

describe('ct_events_get and ct_events_get_agenda', () => {
  it.each([
    [
      'ct_events_get',
      '/api/events/2',
      403,
      'permission',
      eventRefused,
      [viewEvents],
    ],
    [
      'ct_events_get',
      '/api/events/2',
      404,
      'not_found',
      eventNotFound,
      undefined,
    ],
    [
      'ct_events_get_agenda',
      '/api/events/2/agenda',
      403,
      'permission',
      agendaRefused,
      [viewAgenda],
    ],
    [
      'ct_events_get_agenda',
      '/api/events/2/agenda',
      404,
      'not_found',
      agendaNotFound,
      undefined,
    ],
  ] as const)(
    '%s ends %i with %s and names the next step',
    async (name, pathname, status, code, message, missingRights) => {
      const { double, call } = setup();
      double
        .intercept({ path: pathname, method: 'GET' })
        .reply(status, '{}', json);
      const outcome = await call(name, { eventId: 2 });
      expect(!outcome.ok && outcome.error).toEqual({
        code,
        message,
        ...(missingRights === undefined ? {} : { missingRights }),
      });
    },
  );

  it('pages through an agenda, 10 items per call', async () => {
    const { double, call } = setup();
    const answer = agendaAnswer({
      name: 'Ablauf',
      isFinal: false,
      items: Array.from({ length: 12 }, (_, index) => item(index + 1)),
    }).body;
    for (let count = 0; count < 3; count += 1) {
      double
        .intercept({ path: '/api/events/2/agenda', method: 'GET' })
        .reply(200, answer, json);
    }
    const summary = [];
    for (const page of [1, 2, 3]) {
      const outcome = await call('ct_events_get_agenda', { eventId: 2, page });
      const shown = pageOf(outcome, 'items');
      summary.push(
        shown && [
          shown.entries.map((entry) => entry['position']),
          shown.more,
          shown.notice,
        ],
      );
    }
    expect(summary).toEqual([
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true, null],
      [[11, 12], false, null],
      [[], false, pastLastAgendaPage],
    ]);
  });

  it('says so for an agenda without items', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/events/2/agenda', method: 'GET' })
      .reply(
        200,
        agendaAnswer({ name: 'Ablauf', isFinal: false, items: [] }).body,
        json,
      );
    const outcome = await call('ct_events_get_agenda', { eventId: 2 });
    expect(outcome.ok && outcome.data.notice).toBe(noAgendaItem);
  });
});

describe('ct_services_list', () => {
  it('pages through the services, 25 per call, and says so for an empty list', async () => {
    const { double, call } = setup();
    const many = Array.from({ length: 30 }, (_, index) => service(index + 1));
    replyServices(double, many);
    replyServices(double, many);
    replyServices(double, []);
    const first = await call('ct_services_list', {});
    const second = await call('ct_services_list', { page: 2 });
    const none = await call('ct_services_list', {});
    expect(
      [first, second, none].map((outcome) => {
        const shown = pageOf(outcome, 'services');
        return shown && [shown.entries.length, shown.more, shown.notice];
      }),
    ).toEqual([
      [25, true, null],
      [5, false, null],
      [0, false, noServiceListed],
    ]);
  });

  it('says so for an empty later page', async () => {
    const { double, call } = setup();
    replyServices(double, [service(11)]);
    const outcome = await call('ct_services_list', { page: 2 });
    expect(outcome.ok && outcome.data.notice).toBe(pastLastServicePage);
  });

  it('needs no right and is not treated as special', () => {
    const listed = coreCatalog().get('ct_services_list');
    expect(listed?.meta.requiredRights).toEqual([]);
    expect(listed?.asSpecial).toBe(false);
  });
});

describe('ct_services_get_assignments', () => {
  it('is treated like a special tool, but may run unattended by policy', () => {
    const catalog = coreCatalog();
    const listed = catalog.get('ct_services_get_assignments');
    expect(listed?.meta.sensitivity).toBe('personal');
    expect(listed?.meta.unattended).toBe('policy');
    expect(listed?.asSpecial).toBe(true);
    for (const name of [
      'ct_events_list',
      'ct_events_get',
      'ct_events_get_agenda',
    ]) {
      expect(catalog.get(name)?.asSpecial, name).toBe(false);
    }
  });

  it('names the right on the groups of services when no assignment is listed', async () => {
    const { double, call } = setup();
    replyAssignments(double, []);
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(outcome.ok && outcome.data.notice).toBe(noAssignmentListed);
    expect(noAssignmentListed).toContain(
      '"view servicegroup" in churchservice',
    );
  });

  it('passes on no person where the service hides the names, and says so', async () => {
    const { double, call } = setup();
    replyAssignments(
      double,
      [
        assignment(11),
        assignment(14),
        assignment(11, { personId: 0, firstName: '', lastName: 'Platzhalter' }),
      ],
      [service(11), service(14, { hidePersonName: true })],
    );
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    const shown = pageOf(outcome, 'assignments');
    expect(shown && shown.entries.map((entry) => entry['person'])).toEqual([
      { personId: 1, firstName: 'Person', lastName: 'A' },
      null,
      null,
    ]);
    expect(outcome.ok && outcome.data.notice).toBe(someNamesWithheld);
    expect(JSON.stringify(outcome)).not.toContain('Platzhalter');
  });

  it('pages through 30 assignments, 25 per call', async () => {
    const { double, call } = setup();
    const many = Array.from({ length: 30 }, () => assignment(11));
    replyAssignments(double, many);
    replyAssignments(double, many);
    replyAssignments(double, many);
    const summary = [];
    for (const page of [1, 2, 3]) {
      const outcome = await call('ct_services_get_assignments', {
        eventId: 2,
        page,
      });
      const shown = pageOf(outcome, 'assignments');
      summary.push(shown && [shown.entries.length, shown.more, shown.notice]);
    }
    expect(summary).toEqual([
      [25, true, null],
      [5, false, null],
      [0, false, pastLastAssignmentPage],
    ]);
  });

  it('counts every call against the read budget', async () => {
    const { double, quota, call } = setup();
    replyAssignments(double, [assignment(11)]);
    replyAssignments(double, [assignment(11)]);
    await call('ct_services_get_assignments', { eventId: 2 });
    await call('ct_services_get_assignments', { eventId: 2 });
    expect([...quota.values()]).toEqual([2]);
  });

  it('holds its result back when its line is not in the audit file', async () => {
    const { double, call } = setup(coreCatalog(), { recorded: false });
    replyAssignments(double, [assignment(11)]);
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(JSON.stringify(outcome)).not.toContain('Person');
  });

  it('ends 403 of the event with permission and the right', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(403, '{}', json);
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'permission',
      message: eventRefused,
      missingRights: [viewEvents],
    });
  });
});

// A tool whose output names no person may not read the assignments: its
// result would neither wait for its audit line nor count against the read
// budget (ADR 0064).
describe('the read access of a tool not treated as special', () => {
  it('refuses the assignments with policy_denied before any request', async () => {
    const plugin: Plugin = {
      name: '@ecclium/test-events-services',
      version: '0.0.0',
      register(host): undefined {
        host.addTool({
          ...(servicesGetAssignmentsTool as unknown as ToolDefinition),
          output: z.object({ text: classify(z.string(), 'untrusted') }),
          execute: async ({ read }: { read: ReadApi }) => {
            const assignments = await read.eventAssignments(2, 1);
            return { text: JSON.stringify(assignments) };
          },
        });
        return undefined;
      },
    };
    const catalog = createToolCatalog({
      core: plugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['events'] as const),
    });
    expect(catalog.get('ct_services_get_assignments')?.asSpecial).toBe(false);
    const { double, lines, call } = setup(catalog);
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(double.calls()).toEqual([]);
    expect(lines.join('\n')).toContain('read_names_refused');
  });
});

describe('the layer of the tools', () => {
  const leak = makeCanaries();
  const ctx = {} as TenantContext;

  it('copies only the seven fields of an event in the list', async () => {
    const read = {
      events: () =>
        Promise.resolve({
          events: [{ ...entry(2), note: leak.name.value }],
          more: false,
        }),
    } as unknown as ReadApi;
    const result = await eventsListTool.execute({
      ctx,
      input: { from: '2026-10-25', to: '2026-10-25' },
      read,
    });
    expect(result.events).toEqual([entry(2)]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the nine fields of an event', async () => {
    const read = {
      event: () =>
        Promise.resolve({ ...details, adminIds: [leak.phone.value] }),
    } as unknown as ReadApi;
    const result = await eventsGetTool.execute({
      ctx,
      input: { eventId: 2 },
      read,
    });
    expect(result).toEqual(details);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the declared fields of an item and its song', async () => {
    const song = {
      songId: 2,
      arrangementId: null,
      title: 'Lied A',
      arrangement: null,
    };
    const read = {
      eventAgenda: () =>
        Promise.resolve({
          name: 'Ablauf',
          isFinal: false,
          items: [
            {
              ...item(1, { song: { ...song, key: leak.phone.value } as never }),
              responsible: leak.name.value,
            },
          ],
        }),
    } as unknown as ReadApi;
    const result = await eventsGetAgendaTool.execute({
      ctx,
      input: { eventId: 2 },
      read,
    });
    expect(result.items).toEqual([item(1, { song })]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only the declared fields of a service', async () => {
    const read = {
      services: () =>
        Promise.resolve({
          services: [
            {
              id: 11,
              name: 'Dienst 11',
              serviceGroupId: 5,
              hidesNames: false,
              groupIds: [leak.phone.value],
            },
          ],
          serviceGroups: [{ id: 5, name: 'Gruppe', viewAll: leak.name.value }],
        }),
    } as unknown as ReadApi;
    const result = await servicesListTool.execute({ ctx, input: {}, read });
    expect(result.services).toEqual([
      {
        id: 11,
        name: 'Dienst 11',
        serviceGroupId: 5,
        serviceGroupName: 'Gruppe',
        hidesNames: false,
      },
    ]);
    assertNoCanary(result, leak.all, 'result of the tool');
  });

  it('copies only service, states and the three fields of the person', async () => {
    const read = {
      eventAssignments: () =>
        Promise.resolve({
          more: false,
          assignments: [
            {
              serviceId: 11,
              serviceName: 'Dienst 11',
              isAccepted: true,
              agreed: true,
              person: {
                personId: 1,
                firstName: 'Person',
                lastName: 'A',
                email: leak.email.value,
              },
              requesterPerson: leak.name.value,
            },
          ],
        }),
    } as unknown as ReadApi;
    const result = await servicesGetAssignmentsTool.execute({
      ctx,
      input: { eventId: 2 },
      read,
    });
    expect(result.assignments).toEqual([
      {
        serviceId: 11,
        serviceName: 'Dienst 11',
        isAccepted: true,
        agreed: true,
        person: { personId: 1, firstName: 'Person', lastName: 'A' },
      },
    ]);
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
        name: '@ecclium/test-events-services',
        version: '0.0.0',
        register(host): undefined {
          host.addTool({ ...tool, execute: () => Promise.resolve(result) });
          return undefined;
        },
      } satisfies Plugin,
      plugins: [],
      readOnly: true,
      toolsets: new Set(['events'] as const),
    });

  it.each([
    [
      'ct_events_get',
      eventsGetTool,
      { eventId: 2 },
      { ...details, eventServices: [{ name: leak.name.value }] },
      {
        ...shownEntry(2),
        note: enveloped('Notiz des Events'),
        description: enveloped('Beschreibung des Events'),
      },
    ],
    [
      'ct_services_get_assignments',
      servicesGetAssignmentsTool,
      { eventId: 2 },
      {
        eventId: 2,
        page: 1,
        assignments: [
          {
            serviceId: 11,
            serviceName: 'Dienst 11',
            isAccepted: true,
            agreed: true,
            person: {
              personId: 1,
              firstName: 'Person',
              lastName: 'A',
              mobile: leak.phone.value,
            },
            requesterPersonId: leak.token.value,
          },
        ],
        more: false,
        notice: null,
        total: leak.phone.value,
      },
      {
        eventId: 2,
        page: 1,
        assignments: [
          {
            serviceId: 11,
            serviceName: enveloped('Dienst 11'),
            isAccepted: true,
            agreed: true,
            person: { personId: 1, firstName: 'Person', lastName: 'A' },
          },
        ],
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

// A refusal and a missing object end with a fixed message: the body of
// such an answer, which ChurchTools fills with its own texts, reaches
// neither the result nor the log nor the audit.
describe('the body of a refusal', () => {
  const leak = makeCanaries();
  const body = JSON.stringify({
    message: leak.name.value,
    translatedMessage: leak.email.value,
    messageKey: leak.phone.value,
    args: { eventId: leak.token.value },
    errors: [],
  });

  it.each([
    ['ct_events_get', '/api/events/2'],
    ['ct_events_get_agenda', '/api/events/2/agenda'],
    ['ct_services_get_assignments', '/api/events/2'],
  ])('stays out of %s for 403 and 404', async (name, pathname) => {
    for (const status of [403, 404]) {
      const { double, lines, drafts, call } = setup();
      double
        .intercept({ path: pathname, method: 'GET' })
        .reply(status, body, json);
      const outcome = await call(name, { eventId: 2 });
      expect(outcome.ok).toBe(false);
      assertNoCanary([outcome, lines, drafts], leak.all, 'result, log, audit');
    }
  });
});

// The largest results the limits allow still fit into one result of 64
// KiB (ADR 0024): one event with names, note and description of quotes,
// which the two copies of the result each escape, and the lists with
// names, titles and notes of letters. Longer texts beyond ASCII in a full
// page of a list can exceed it; the call then ends with an error, as for
// the search tools (ADR 0060, ADR 0064).
describe('the largest results', () => {
  const quotes = (count: number) => '"'.repeat(count);
  const letters = (count: number) => 'a'.repeat(count);

  it('passes an event with names, note and description of quotes', async () => {
    const { double, call } = setup();
    double.intercept({ path: '/api/events/2', method: 'GET' }).reply(
      200,
      eventAnswer({
        ...details,
        name: quotes(255),
        calendarName: quotes(255),
        note: quotes(2000),
        description: quotes(7000),
      }).body,
      json,
    );
    const outcome = await call('ct_events_get', { eventId: 2 });
    expect(outcome.ok).toBe(true);
  });

  it('passes a page of 25 events with names of 255 letters', async () => {
    const { double, call } = setup();
    double.intercept({ path: at('/api/events'), method: 'GET' }).reply(
      200,
      eventsAnswer(
        Array.from({ length: 25 }, (_, index) => ({
          ...entry(index + 1),
          name: letters(255),
          calendarName: letters(255),
        })),
      ).body,
      json,
    );
    const outcome = await call('ct_events_list', {
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(outcome.ok && outcome.data.events).toHaveLength(25);
  });

  it('passes a page of 10 items with titles of 255 and notes of 1000 letters', async () => {
    const { double, call } = setup();
    double.intercept({ path: '/api/events/2/agenda', method: 'GET' }).reply(
      200,
      agendaAnswer({
        name: letters(255),
        isFinal: false,
        items: Array.from({ length: 10 }, (_, index) =>
          item(index + 1, {
            title: letters(255),
            note: letters(1000),
            song: {
              songId: 2,
              arrangementId: 3,
              title: letters(255),
              arrangement: letters(255),
            },
          }),
        ),
      }).body,
      json,
    );
    const outcome = await call('ct_events_get_agenda', { eventId: 2 });
    expect(outcome.ok && outcome.data.items).toHaveLength(10);
  });

  it('passes a page of 25 services with names of 255 letters', async () => {
    const { double, call } = setup();
    double.intercept({ path: '/api/services', method: 'GET' }).reply(
      200,
      servicesAnswer(
        Array.from({ length: 25 }, (_, index) => ({
          ...service(index + 1),
          name: letters(255),
        })),
      ).body,
      json,
    );
    double
      .intercept({ path: '/api/servicegroups', method: 'GET' })
      .reply(
        200,
        serviceGroupsAnswer([{ id: 5, name: letters(255) }]).body,
        json,
      );
    const outcome = await call('ct_services_list', {});
    expect(outcome.ok && outcome.data.services).toHaveLength(25);
  });

  it('passes a page of 25 assignments with names of 255 letters', async () => {
    const { double, call } = setup();
    double
      .intercept({ path: '/api/events/2', method: 'GET' })
      .reply(
        200,
        eventAssignmentsAnswer(
          Array.from({ length: 25 }, () =>
            assignment(11, { firstName: letters(255), lastName: letters(255) }),
          ),
        ).body,
        json,
      );
    double
      .intercept({ path: '/api/services', method: 'GET' })
      .reply(
        200,
        servicesAnswer([{ ...service(11), name: letters(255) }]).body,
        json,
      );
    const outcome = await call('ct_services_get_assignments', { eventId: 2 });
    expect(outcome.ok && outcome.data.assignments).toHaveLength(25);
  });
});
