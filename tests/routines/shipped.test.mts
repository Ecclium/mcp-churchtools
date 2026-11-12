import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createToolCatalog,
  describeRunTool,
  guardModelProvider,
  type Policy,
  type RunCallOutcome,
} from '@ecclium/mcp-churchtools-core';
import {
  isEventWindow,
  isListIds,
  type Logger,
  type ModelRequest,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMockModelProvider,
  redactedOutcome,
} from '@ecclium/mcp-churchtools-testkit';
import {
  appointmentsListTool,
  createCorePlugin,
} from '@ecclium/mcp-churchtools-tools';
import {
  executeRun,
  type LoadedRoutine,
  loadRoutines,
  type PreparedRun,
  prepareRun,
  type RunRead,
} from '@ecclium/mcp-churchtools-workflows';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The routines the repository ships in routines/, loaded from disk with the
// real loader, prepared against the read tools of the core and run on a
// stand-in of the reads and of the model up to the rendered section. The
// stand-in gives fields as the tools do, not every field; what the tools
// and the level strict give is tested with them. The
// schema the loader checks is the one schemas/routine.v1.json is made from.
// A checkout gives files the rights its umask allows, and the loader
// refuses a file the group may write, so the test copies the folder and
// sets the rights itself. All data are made up.

const shipped = fileURLToPath(new URL('../../routines', import.meta.url));

let root = '';
let folder = '';

// Every folder 0755 and every file 0644, as an operator would set them.
const setRights = (path: string): void => {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const inner = join(path, entry.name);
    if (entry.isDirectory()) setRights(inner);
    else chmodSync(inner, 0o644);
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ecclium-shipped-'));
  folder = join(root, 'routines');
  cpSync(shipped, folder, { recursive: true });
  setRights(folder);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const loadShipped = (): readonly LoadedRoutine[] => {
  const loaded = loadRoutines(folder);
  if (!loaded.ok) throw new Error(`not loaded: ${loaded.code}`);
  return loaded.routines;
};

const routineOf = (id: string): LoadedRoutine => {
  const found = loadShipped().find(({ routine }) => routine.id === id);
  if (found === undefined) throw new Error(`no routine ${id}`);
  return found;
};

// The read tools of the core with every toolset a shipped routine reads.
const catalog = createToolCatalog({
  core: createCorePlugin(),
  plugins: [],
  readOnly: true,
  toolsets: new Set(['calendars', 'events', 'wiki'] as const),
});

// The entry an operator writes for the page of the report.
const policy = {
  schema: 'policy.v1',
  interactive: { readBudgetPerDay: 200, targets: [] },
  unattended: [
    {
      routine: 'dienstplan-report',
      credential: 'runner',
      target: {
        kind: 'wiki_page',
        categoryId: 7,
        guid: 'seite-dienstplan',
        name: 'Dienstplan-Auswertung',
      },
      tools: ['ct_wiki_page_append_section'],
      maxPerRun: 1,
      maxPerDay: 2,
    },
  ],
} as unknown as Policy;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const trigger = {
  at: Date.UTC(2026, 10, 16, 5),
  period: { isoWeek: '2026-W47', date: '2026-11-16', month: '2026-11' },
};

// Two persons as the model sees them in the level strict.
const anna = `p1_${'a'.repeat(39)}`;
const bert = `p1_${'b'.repeat(39)}`;
const names: Readonly<Record<string, string>> = {
  [anna]: 'Anna Beispiel',
  [bert]: 'Bert Muster',
};

const outcome = (
  data: Readonly<Record<string, unknown>>,
  entries: number,
  persons: Readonly<Record<string, string>> = {},
): RunCallOutcome => {
  const made = redactedOutcome(data);
  if (!made.ok) throw new Error('no data');
  return { ok: true, data: made.data, entries, more: false, persons };
};

const person = (id: string) => ({
  personId: id,
  firstName: (names[id] ?? '').split(' ')[0],
  lastName: (names[id] ?? ' ').split(' ')[1]?.charAt(0),
});

// Two services in two weeks: a free place, a request without a promise, a
// hidden name and one person on both days.
const read: RunRead = (tool, input) => {
  if (tool === 'ct_events_list') {
    return Promise.resolve(
      outcome(
        {
          events: [
            { id: 1, name: 'Gottesdienst', startDate: '2026-11-22T09:00:00Z' },
            { id: 2, name: 'Gottesdienst', startDate: '2026-11-29T09:00:00Z' },
          ],
          more: false,
        },
        2,
      ),
    );
  }
  const first = input['eventId'] === 1;
  return Promise.resolve(
    outcome(
      {
        eventId: input['eventId'],
        page: 1,
        assignments: first
          ? [
              {
                serviceName: 'Technik',
                assigned: true,
                isAccepted: true,
                person: person(anna),
              },
              {
                serviceName: 'Technik',
                assigned: false,
                isAccepted: false,
                person: null,
              },
            ]
          : [
              {
                serviceName: 'Technik',
                assigned: true,
                isAccepted: true,
                person: person(anna),
              },
              {
                serviceName: 'Musik',
                assigned: true,
                isAccepted: false,
                person: person(bert),
              },
              {
                serviceName: 'Seelsorge',
                assigned: true,
                isAccepted: false,
                person: null,
              },
            ],
        more: false,
      },
      first ? 2 : 3,
      first ? { [anna]: names[anna] ?? '' } : names,
    ),
  );
};

describe('the shipped routines', () => {
  it('load with their prompts and templates and leave the guide aside', () => {
    expect(loadShipped().map(({ routine }) => routine.id)).toEqual([
      'dienstplan-report',
      'termin-vorschau',
    ]);
  });
});

describe('the shipped routine dienstplan-report', () => {
  it('prepares against the read tools of the core, at strict and for its page', () => {
    const prepared = prepareRun(routineOf('dienstplan-report'), {
      tool: (name) => describeRunTool(catalog, name),
      policy,
      models: new Set(['default']),
    });
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.code}`);
    expect(prepared.run.inputs.map(({ input }) => input.tool)).toEqual([
      'ct_events_list',
      'ct_services_get_assignments',
    ]);
    expect(prepared.run.redaction).toBe('strict');
    expect(prepared.run.target?.target.name).toBe('Dienstplan-Auswertung');
    expect(prepared.run.credential).toBe('runner');
  });

  it('renders the blocks of a stand-in model with the names of the run, and gives the model no name of the run', async () => {
    const prepared = prepareRun(routineOf('dienstplan-report'), {
      tool: (name) => describeRunTool(catalog, name),
      policy,
      models: new Set(['default']),
    });
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.code}`);
    const asked: ModelRequest<unknown>[] = [];
    const model = guardModelProvider(
      createMockModelProvider({
        kind: 'obedient',
        respond: (request) => {
          asked.push(request);
          return {
            unbesetzt: [
              {
                datum: '2026-11-22',
                termin: 'Gottesdienst',
                dienst: 'Technik',
              },
            ],
            offen: [
              {
                datum: '2026-11-29',
                termin: 'Gottesdienst',
                dienst: 'Musik',
                person: bert,
              },
            ],
            mehrfach: [{ person: anna, anzahl: 2 }],
            hinweise: [
              { text: 'Eine Anfrage ohne Zusage hat einen verborgenen Namen.' },
            ],
          };
        },
      }).provider,
    );
    const result = await executeRun(
      prepared.run,
      trigger,
      { read, model, policy, log: silent, clock: { now: () => trigger.at } },
      new AbortController().signal,
    );
    if (result.kind !== 'rendered') throw new Error(result.code);
    expect(result.section).toContain('### Dienstplan ab Woche 2026-W47');
    // The core writes a date as a day of the calendar, its first dot
    // escaped so that it starts no list.
    expect(result.section).toContain('22\\.11.2026, Gottesdienst: Technik');
    expect(result.section).toContain(
      '29\\.11.2026, Gottesdienst: Musik, angefragt bei Bert Muster',
    );
    expect(result.section).toContain('Anna Beispiel: 2 Einteilungen');
    expect(result.section).toContain(
      'Eine Anfrage ohne Zusage hat einen verborgenen Namen',
    );
    expect(result.section).not.toContain('p1_');
    // The model got the prompt of the routine and whether a place is
    // filled. The stand-in of the reads shortens last names as the level
    // strict does; the names of the run never reach the request.
    const [request] = asked;
    const text = JSON.stringify(request);
    expect(text).toContain('`assigned` gleich `false`');
    const data = request?.parts.find(
      (part) => part.kind === 'data' && part.name === 'einteilungen',
    );
    expect(data?.kind === 'data' ? data.text : '').toContain(
      '"assigned":false',
    );
    expect(text).not.toContain('Beispiel');
    expect(text).not.toContain('Muster');
  });
});

describe('the shipped routine termin-vorschau', () => {
  const prepare = (): PreparedRun => {
    const prepared = prepareRun(routineOf('termin-vorschau'), {
      tool: (name) => describeRunTool(catalog, name),
      policy,
      models: new Set(['default']),
    });
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.code}`);
    return prepared.run;
  };

  it('prepares against the read tools of the core, at strict and without an entry, for the account of the runner', () => {
    const run = prepare();
    expect(run.inputs.map(({ input }) => input.tool)).toEqual([
      'ct_appointments_list',
    ]);
    expect(run.inputs[0]?.input.params['calendarIds']).toEqual([1]);
    expect(run.redaction).toBe('strict');
    expect(run.loaded.routine.output).toMatchObject({
      target: 'draft',
      channel: 'file',
    });
    // No entry of the policy: the run reads with the own account of the
    // runner and writes nothing in ChurchTools.
    expect(run.entries).toEqual([]);
    expect(run).not.toHaveProperty('target');
    expect(run).not.toHaveProperty('credential');
  });

  it('gives the tool its calendars as a list and days it takes, and renders the draft', async () => {
    const inputs: Readonly<Record<string, unknown>>[] = [];
    const read: RunRead = (tool, input) => {
      if (tool !== 'ct_appointments_list') throw new Error(tool);
      inputs.push(input);
      return Promise.resolve(
        outcome(
          {
            from: input['from'],
            to: input['to'],
            page: 1,
            appointments: [
              {
                id: 11,
                calendarId: 1,
                title: 'Gottesdienst',
                subtitle: 'mit Abendmahl',
                allDay: false,
                locationName: 'Kirche',
                startDate: '2026-11-29T09:00:00Z',
                endDate: '2026-11-29T10:30:00Z',
              },
              {
                id: 12,
                calendarId: 1,
                title: 'Adventsbasar',
                subtitle: null,
                allDay: true,
                locationName: 'Gemeindehaus',
                startDate: '2026-12-05',
                endDate: '2026-12-05',
              },
            ],
            more: false,
            notice: null,
          },
          2,
        ),
      );
    };
    const asked: ModelRequest<unknown>[] = [];
    const model = guardModelProvider(
      createMockModelProvider({
        kind: 'obedient',
        respond: (request) => {
          asked.push(request);
          return {
            termine: [
              {
                datum: '2026-11-29',
                zeit: '10:00 Uhr',
                titel: 'Gottesdienst',
                text: 'Gottesdienst mit Abendmahl in der Kirche.',
              },
              {
                datum: '2026-12-05',
                zeit: 'ganztägig',
                titel: 'Adventsbasar',
                text: 'Adventsbasar *mit Café* im Gemeindehaus.',
              },
            ],
            hinweise: [],
          };
        },
      }).provider,
    );
    const result = await executeRun(
      prepare(),
      trigger,
      { read, model, policy, log: silent, clock: { now: () => trigger.at } },
      new AbortController().signal,
    );
    if (result.kind !== 'rendered') throw new Error(result.code);
    // One call with the calendars as a list and the days from a week to
    // five weeks after the trigger, which the tool itself takes: the
    // checks of its schema and of its execution.
    expect(inputs).toEqual([
      {
        calendarIds: [1],
        from: '2026-11-23',
        to: '2026-12-21',
        page: 1,
      },
    ]);
    const [input] = inputs;
    expect(appointmentsListTool.input.safeParse(input).success).toBe(true);
    expect(isListIds(input?.['calendarIds'])).toBe(true);
    expect(isEventWindow(input?.['from'], input?.['to'])).toBe(true);
    expect(result.section).toContain('## Termine für den Gemeindebrief');
    expect(result.section).toContain('Entwurf der Woche 2026-W47');
    expect(result.section).toContain(
      '- **29.11.2026, 10:00 Uhr, Gottesdienst:** Gottesdienst mit Abendmahl in der Kirche.',
    );
    // What the model writes as plain text marks nothing up.
    expect(result.section).toContain(
      '- **05.12.2026, ganztägig, Adventsbasar:** Adventsbasar \\*mit Café\\* im Gemeindehaus.',
    );
    expect(result.section).toContain('Keine Hinweise.');
    // The model got the prompt of the routine and the appointments.
    const [request] = asked;
    expect(JSON.stringify(request)).toContain('Gemeindebrief');
    const data = request?.parts.find(
      (part) => part.kind === 'data' && part.name === 'termine',
    );
    expect(data?.kind === 'data' ? data.text : '').toContain('Adventsbasar');
  });
});
