import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createToolCatalog,
  createToolPipeline,
  defaultPolicy,
  loadConfig,
  type ToolPipelineOptions,
  type ToolRequest,
} from '@ecclium/mcp-churchtools-core';
import {
  EccliumError,
  maxNameLength,
  type NonceStore,
  type PlanOutcome,
  type PlannedWrite,
  type PlanStore,
  type ReadApi,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
  type WriteIntent,
  type WritePort,
  type WriteToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  appointmentsAnswer,
  assertOnlyReads,
  bookingsAnswer,
  calendarsAnswer,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  makeCanaries,
  resourcesAnswer,
  resourceTypesAnswer,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appointmentsCreateTool,
  appointmentsUpdateTool,
  maxCalendarDescriptionLength,
} from './appointments/write.js';
import { bookingsCreateTool } from './bookings/write.js';
import { createCorePlugin } from './core-plugin.js';

// The three tools that write appointments and request bookings only plan:
// each hands one intent to the write port and gives back what the port
// gave. The first part runs them alone with a port that records the
// intents, the second through the pipeline of the core on the double of
// ChurchTools, up to the confirmation, as the server runs them (ADR 0029).

const start = '2026-11-08T09:00:00Z';
const end = '2026-11-08T10:00:00Z';
const planned: PlanOutcome = Object.freeze({
  kind: 'planned',
  plan: Object.freeze({}) as PlannedWrite,
});

const portOf = (
  answer: () => Promise<PlanOutcome>,
): { port: WritePort; intents: WriteIntent[] } => {
  const intents: WriteIntent[] = [];
  return {
    intents,
    port: {
      plan: (intent) => {
        intents.push(intent);
        return answer();
      },
    },
  };
};

const run = (
  tool: ToolDefinition,
  input: unknown,
  write: WritePort,
): Promise<unknown> => {
  const parsed = tool.input.parse(input);
  const call: WriteToolCall<unknown> = {
    ctx: {} as TenantContext,
    input: parsed,
    read: {} as ReadApi,
    write,
  };
  return tool.execute(call);
};

const createInput = {
  calendarId: 8,
  title: 'Chorprobe',
  startDate: start,
  endDate: end,
  description: 'Im Saal',
};
const updateInput = {
  calendarId: 8,
  appointmentId: 21,
  baseVersion: 2,
  title: 'Chorprobe',
  startDate: start,
  endDate: end,
  description: 'Im Saal',
};
const bookingInput = {
  resourceId: 13,
  title: 'Chorprobe',
  startDate: start,
  endDate: end,
  description: 'Im Saal',
};

// The input without its description, which every tool may leave out.
const withoutDescription = (
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'description'),
  );

const cases = [
  {
    tool: appointmentsCreateTool,
    input: createInput,
    intent: { kind: 'appointmentCreate', ...createInput },
    domain: 'appointments',
    rights: [
      { module: 'churchcal', right: 'edit category' },
      { module: 'churchcal', right: 'view category' },
    ],
    replayGuard: 'nonce',
  },
  {
    tool: appointmentsUpdateTool,
    input: updateInput,
    intent: { kind: 'appointmentUpdate', ...updateInput },
    domain: 'appointments',
    rights: [
      { module: 'churchcal', right: 'edit category' },
      { module: 'churchcal', right: 'view category' },
    ],
    replayGuard: 'baseVersion',
  },
  {
    tool: bookingsCreateTool,
    input: bookingInput,
    intent: { kind: 'bookingCreate', ...bookingInput },
    domain: 'bookings',
    rights: [
      { module: 'churchresource', right: 'create bookings' },
      { module: 'churchresource', right: 'view resource' },
    ],
    replayGuard: 'nonce',
  },
] as const;

describe.each(cases)(
  '$tool.name',
  ({ tool, input, intent, domain, rights, replayGuard }) => {
    it('hands exactly its intent to the write port and gives back its plan', async () => {
      const { port, intents } = portOf(() => Promise.resolve(planned));
      await expect(run(tool, input, port)).resolves.toBe(planned);
      expect(intents).toEqual([intent]);
    });

    // A missing description is no field of the intent at all: the core
    // keeps the current one on a change and writes none on a new entry.
    it('leaves a missing description out of the intent', async () => {
      const { port, intents } = portOf(() => Promise.resolve(planned));
      await run(tool, withoutDescription(input), port);
      expect(intents).toHaveLength(1);
      expect(Object.hasOwn(intents[0] as object, 'description')).toBe(false);
    });

    it('gives back a skipped plan as the port gave it', async () => {
      const skipped: PlanOutcome = { kind: 'skipped', reason: 'unchanged' };
      const { port } = portOf(() => Promise.resolve(skipped));
      await expect(run(tool, input, port)).resolves.toBe(skipped);
    });

    it.each([
      new EccliumError('conflict', 'changed'),
      new EccliumError('permission', 'right', { missingRights: rights }),
      new EccliumError('policy_denied', 'whole days'),
      new EccliumError('validation', 'times'),
      new EccliumError('not_found'),
      new TypeError('not an error of the core'),
    ])(
      'passes on every other refusal as the core made it: %s',
      async (error) => {
        const { port } = portOf(() => Promise.reject(error));
        await expect(run(tool, input, port)).rejects.toBe(error);
      },
    );

    it('refuses an argument the model made up', () => {
      expect(tool.input.safeParse({ ...input, note: 'x' }).success).toBe(false);
    });

    // What the core derives for the intent anyway (ADR 0029), so that the
    // description names the rights the write really needs. The pipeline
    // tests below show that the core checks each of them.
    it('is a write the core can take back, with the rights of its intent', () => {
      expect(tool.meta).toMatchObject({
        capability: 'write',
        domain,
        tier: 'free',
        sensitivity: 'personal',
        unattended: 'policy',
        routineStable: false,
        reversible: 'snapshot',
        replayGuard,
      });
      expect(tool.meta.requiredRights).toEqual(rights);
    });

    // Each description stands for itself (ADR 0065): it names no other
    // tool, says that a confirmation comes before every write, and how the
    // model gives the times and the text.
    it('names no other tool and says the confirmation, the times and the text', () => {
      const text = Object.values(tool.description).join(' ');
      expect(text).not.toContain('ct_');
      expect(text).toContain('Writes only after a confirmation');
      expect(text).toContain(
        'Times in UTC on the full minute as YYYY-MM-DDTHH:MM:00Z',
      );
      expect(text).toContain('No whole days.');
      expect(text).toContain(
        `description up to ${String(maxCalendarDescriptionLength)} characters`,
      );
    });
  },
);

describe('the descriptions', () => {
  // A booking request mails the managers at once, and a change may mail
  // the person who created the appointment: neither goes by echo, which
  // proves no will of a person (ADR 0029).
  it('say that a change and a booking request are never confirmed by echo, a new appointment may be', () => {
    expect(appointmentsUpdateTool.description.limits).toContain(
      'Never confirmed by echo.',
    );
    expect(bookingsCreateTool.description.limits).toContain(
      'Never confirmed by echo.',
    );
    expect(appointmentsCreateTool.description.limits).not.toContain('echo');
  });

  it('say that a booking is only a request mailed to the managers', () => {
    expect(bookingsCreateTool.description.limits).toContain(
      'Only a request: the managers of the resource approve it and get its title and description by mail at once.',
    );
  });

  // The core skips any entry of the same title and times, whoever made it:
  // neither the list of appointments nor that of bookings names a creator.
  it('say which repeat is skipped and that a change moves only appointments of this server', () => {
    expect(appointmentsCreateTool.description.limits).toContain(
      'The same title, start and end in the calendar is skipped.',
    );
    expect(bookingsCreateTool.description.limits).toContain(
      'A request or booking of the resource with the same title, start and end is skipped.',
    );
    expect(appointmentsUpdateTool.description.limits).toContain(
      'Start and end change only where this server created the appointment.',
    );
  });
});

describe('the input of the tools', () => {
  it.each([
    ['an empty title', { title: '' }],
    ['a title over the limit', { title: 'T'.repeat(maxNameLength + 1) }],
    ['an empty description', { description: '' }],
    [
      'a description over the limit',
      { description: 'x'.repeat(maxCalendarDescriptionLength + 1) },
    ],
    ['a day without a time', { startDate: '2026-11-08' }],
    ['a time without Z', { startDate: '2026-11-08T09:00:00' }],
    ['a time with an offset', { endDate: '2026-11-08T10:00:00+01:00' }],
    ['a time with a fraction', { endDate: '2026-11-08T10:00:00.000Z' }],
    ['no end', { endDate: undefined }],
  ])('refuses %s in each tool', (_, change) => {
    for (const { tool, input } of cases) {
      expect(
        tool.input.safeParse({ ...input, ...change }).success,
        tool.name,
      ).toBe(false);
    }
  });

  it('takes the longest title and description and no description', () => {
    for (const { tool, input } of cases) {
      const longest = {
        ...input,
        title: 'T'.repeat(maxNameLength),
        description: 'x'.repeat(maxCalendarDescriptionLength),
      };
      expect(tool.input.safeParse(longest).success, tool.name).toBe(true);
      expect(
        tool.input.safeParse(withoutDescription(input)).success,
        tool.name,
      ).toBe(true);
    }
  });

  it.each([
    ['a calendar 0', appointmentsCreateTool, { calendarId: 0 }],
    ['a calendar as text', appointmentsCreateTool, { calendarId: '8' }],
    ['an appointment 0', appointmentsUpdateTool, { appointmentId: 0 }],
    ['a version below 0', appointmentsUpdateTool, { baseVersion: -1 }],
    ['a version with a fraction', appointmentsUpdateTool, { baseVersion: 2.5 }],
    ['no version', appointmentsUpdateTool, { baseVersion: undefined }],
    ['no title on a change', appointmentsUpdateTool, { title: undefined }],
    ['a resource 0', bookingsCreateTool, { resourceId: 0 }],
    ['a calendar instead of a resource', bookingsCreateTool, { calendarId: 8 }],
  ])('refuses %s', (_, tool, change) => {
    const input = cases.find((entry) => entry.tool === tool)?.input;
    expect(tool.input.safeParse({ ...input, ...change }).success).toBe(false);
  });

  // A new appointment has version 0 (F42), so a change of it names 0.
  it('takes version 0 for a change', () => {
    expect(
      appointmentsUpdateTool.input.safeParse({ ...updateInput, baseVersion: 0 })
        .success,
    ).toBe(true);
  });
});

// Through the pipeline of the core, with the catalog of a server that
// writes and offers the toolset calendars and the echo: the plan reads
// ChurchTools, writes nothing, and the confirmation takes the way the
// rules of the core allow.

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const now = Date.UTC(2026, 10, 7, 8, 0, 0);
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};
const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

type AuditSink = ToolPipelineOptions['audit'];

// The stores of plans and nonces in memory, as the composition root hands
// them over; the stores of the core are its to import (ADR 0029).
const planStore = (): PlanStore => {
  const plans = new Map<string, PlannedWrite>();
  return {
    put: (_ctx, hash, plan) => {
      plans.set(hash, plan);
      return Promise.resolve('stored');
    },
    take: (_ctx, hash) => {
      const plan = plans.get(hash);
      plans.delete(hash);
      return Promise.resolve(plan);
    },
  };
};
const nonceStore = (): NonceStore => {
  const used = new Set<string>();
  return {
    consume: (_ctx, nonce) => {
      if (used.has(nonce)) return Promise.resolve('replayed');
      used.add(nonce);
      return Promise.resolve('fresh');
    },
  };
};

const open: { close(): Promise<void> }[] = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-calendar-writes-'));
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const request = (elicitation: boolean): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: false,
  features: [],
  signal: new AbortController().signal,
  elicitation,
});

// The rights of the account: those of the three tools for calendar 8 and
// resource 13, unless a test takes one away.
const allGranted = () => ({
  churchcal: { 'edit category': [8], 'view category': [8] },
  churchresource: { 'create bookings': [13], 'view resource': [13] },
});

const setup = (granted: Readonly<Record<string, unknown>> = allGranted()) => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const catalog = createToolCatalog({
    core: createCorePlugin({ writing: true }),
    plugins: [],
    readOnly: false,
    toolsets: new Set(['calendars'] as const),
    echo: true,
  });
  const audit: AuditSink = Object.freeze({
    record: () => true,
    hasFile: true,
    ready: () => true,
    failures: () => 0,
  });
  const pipeline = createToolPipeline({
    policy: defaultPolicy,
    quota: createMemoryQuotaStore(),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock: Object.freeze({ now: Object.freeze(() => now) }),
    logging: {
      writer: Object.freeze({ write: () => true }),
      minLevel: 'debug',
    },
    killSwitchDir: dir,
    // Without snapshots every plan is sealed as not reversible, and the
    // echo confirms none (ADR 0031). No test here commits, so none is kept.
    snapshots: {
      save: () => Promise.resolve(),
      load: () => Promise.reject(new Error('no snapshot is read here')),
    },
    plans: planStore(),
    nonces: nonceStore(),
    confirmation: 'echo-allowed',
  });
  const reply = (path: string | ((path: string) => boolean), body: string) =>
    double.intercept({ path, method: 'GET' }).reply(200, body, json);
  reply('/api/permissions/global', JSON.stringify({ data: granted }));
  reply(
    '/api/calendars',
    calendarsAnswer([
      { id: 8, name: 'Proben', isPublic: false, isPrivate: false },
    ]).body,
  );
  return { double, pipeline, reply, catalog };
};

// The reads of each plan besides the rights and the calendar.
const replyDays = (reply: ReturnType<typeof setup>['reply']) => {
  reply(at('/api/calendars/appointments'), appointmentsAnswer([]).body);
};
const replyAppointment = (
  reply: ReturnType<typeof setup>['reply'],
  version: number,
) => {
  reply(
    at('/api/calendars/8/appointments/21'),
    JSON.stringify({
      data: {
        appointment: {
          id: 21,
          version,
          calendar: { id: 8 },
          title: 'Probe',
          subtitle: null,
          description: 'Im Saal',
          startDate: start,
          endDate: end,
          allDay: false,
          isInternal: false,
          repeatId: 0,
          meta: { createdPerson: { id: 41 } },
        },
        calculatedDates: [{ startDate: start, endDate: end }],
      },
    }),
  );
};
const replyResource = (reply: ReturnType<typeof setup>['reply']) => {
  reply(at('/api/bookings'), bookingsAnswer([]).body);
  reply(
    '/api/resources',
    resourcesAnswer([{ id: 13, name: 'Saal', resourceTypeId: 5 }]).body,
  );
  reply(
    '/api/resourcetypes',
    resourceTypesAnswer([{ id: 5, name: 'Räume' }]).body,
  );
};

describe('the tools that write appointments and request bookings, through the pipeline', () => {
  it('are offered to a server that writes with the toolset calendars, without the wiki', () => {
    const { catalog } = setup();
    for (const name of [
      'ct_appointments_create',
      'ct_appointments_update',
      'ct_bookings_create',
    ]) {
      expect(catalog.get(name)?.origin, name).toBe('core');
    }
    expect(catalog.has('ct_wiki_page_create')).toBe(false);
  });

  // A new appointment can be taken back without anyone having learned of
  // it, so the echo may confirm it where the operator allows the echo.
  it('plan a new appointment and offer the echo, after reads only', async () => {
    const { double, pipeline, reply } = setup();
    replyDays(reply);
    const outcome = await pipeline.call(
      'ct_appointments_create',
      createInput,
      request(false),
    );
    expect(outcome.ok ? outcome.data['state'] : outcome).toBe('planned');
    expect(outcome.ok && outcome.data['target']).toEqual({
      kind: 'calendar',
      key: '8',
    });
    assertOnlyReads(double);
  });

  // The core takes the longest description the tool takes: the plan
  // passes its checks, which would refuse a longer one with `validation`,
  // and its diff of a few lines still fits the echo (ADR 0029).
  it('plan a new appointment with the longest description the tool takes', async () => {
    const { double, pipeline, reply } = setup();
    replyDays(reply);
    const outcome = await pipeline.call(
      'ct_appointments_create',
      { ...createInput, description: 'x'.repeat(maxCalendarDescriptionLength) },
      request(false),
    );
    expect(outcome.ok ? outcome.data['state'] : outcome).toBe('planned');
    assertOnlyReads(double);
  });

  // Each right a tool names is one the core checks: without any one of
  // them the plan ends before it reads the target, and the error names
  // the right (ADR 0029). With all of them, the tests above plan.
  it.each(
    cases.flatMap(({ tool, input, rights }) =>
      rights.map((right) => [tool.name, right.right, input, right] as const),
    ),
  )('%s needs "%s"', async (name, _, input, right) => {
    const granted: Record<string, Record<string, number[]>> = allGranted();
    delete granted[right.module]?.[right.right];
    const { double, pipeline, reply } = setup(granted);
    if (name === 'ct_appointments_create') replyDays(reply);
    else if (name === 'ct_appointments_update') replyAppointment(reply, 2);
    else replyResource(reply);
    const outcome = await pipeline.call(name, input, request(true));
    expect(outcome.ok ? outcome.data : outcome.error.code).toBe('permission');
    expect(!outcome.ok && outcome.error.missingRights).toEqual([right]);
    assertOnlyReads(double);
  });

  // The counter-check of the echo: a change and a booking request tell
  // people outside the client, so without a question in the client they
  // go to the queue, which this pipeline does not have.
  it.each([
    ['ct_appointments_update', updateInput],
    ['ct_bookings_create', bookingInput],
  ] as const)(
    '%s is never confirmed by echo: without a question it needs the operator',
    async (name, input) => {
      const { double, pipeline, reply } = setup();
      if (name === 'ct_appointments_update') replyAppointment(reply, 2);
      else replyResource(reply);
      const outcome = await pipeline.call(name, input, request(false));
      expect(outcome.ok ? outcome.data : outcome.error.code).toBe(
        'confirmation_required',
      );
      // No question either: the client said it cannot be asked.
      expect('question' in outcome && outcome.question !== undefined).toBe(
        false,
      );
      assertOnlyReads(double);
    },
  );

  it.each([
    ['ct_appointments_create', createInput],
    ['ct_appointments_update', { ...updateInput, baseVersion: 0 }],
    ['ct_bookings_create', bookingInput],
  ] as const)(
    '%s asks a client that can be asked, after reads only',
    async (name, input) => {
      const { double, pipeline, reply } = setup();
      if (name === 'ct_appointments_create') replyDays(reply);
      else if (name === 'ct_appointments_update') replyAppointment(reply, 0);
      else replyResource(reply);
      const outcome = await pipeline.call(name, input, request(true));
      expect(outcome.ok).toBe(false);
      expect(
        !outcome.ok && 'question' in outcome && outcome.question !== undefined,
      ).toBe(true);
      assertOnlyReads(double);
    },
  );
});
