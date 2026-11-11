import type {
  Policy,
  RunCallOutcome,
  RunToolFacts,
  Trigger,
} from '@ecclium/mcp-churchtools-core';
import { guardModelProvider } from '@ecclium/mcp-churchtools-core';
import type { Logger } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMockModelProvider,
  redactedOutcome,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { checkRoutine } from '../routine/check.js';
import type { LoadedRoutine } from '../routine/loader.js';
import { parseTemplate } from '../routine/template.js';
import { checkAnswer, unnamedPerson } from './answer.js';
import { executeRun } from './execute.js';
import { readInputs, type RunRead, runReadLimits } from './inputs.js';
import { outputSpecOf } from './output-spec.js';
import { type PreparedRun, prepareRun } from './prepare.js';
import { renderSection } from './render.js';

// The parts of the engine of a run on stand-ins (ADR 0033): the
// preparation against tools, policy and models, the schema of the answer,
// the reads, the check of the answer and the template. A whole run on the
// pipeline of the core runs in the tests of the composition root.

const facts = (over: Partial<RunToolFacts> = {}): RunToolFacts => ({
  capability: 'read',
  routineStable: true,
  unattended: 'policy',
  params: ['from', 'page', 'to'],
  list: 'events',
  entryFields: ['id', 'name'],
  paged: true,
  ...over,
});

const tools: Readonly<Record<string, RunToolFacts>> = {
  ct_events_list: facts(),
  ct_services_get_assignments: facts({
    params: ['eventId', 'page'],
    list: 'assignments',
    entryFields: ['serviceId'],
  }),
  ct_whoami: facts({ routineStable: false, params: [] }),
  ct_write: facts({ capability: 'write' }),
  ct_never: facts({ unattended: 'never' }),
};

const routineValue = (over: Record<string, unknown> = {}) => ({
  schema: 'routine.v1',
  id: 'bericht',
  schedule: '0 6 * * MON',
  inputs: [
    {
      name: 'termine',
      tool: 'ct_events_list',
      params: { from: '+0d', to: '+14d' },
      maxItems: 3,
    },
    {
      name: 'einteilungen',
      tool: 'ct_services_get_assignments',
      forEach: 'termine',
      params: { eventId: { field: 'id' } },
      maxItems: 5,
    },
  ],
  generate: {
    prompt: 'p.md',
    model: 'default',
    output: {
      blocks: {
        liste: {
          maxItems: 3,
          fields: {
            text: { type: 'text', maxLength: 40 },
            tag: { type: 'date' },
            zahl: { type: 'integer', min: 1, max: 9 },
            person: { type: 'person' },
          },
        },
      },
    },
  },
  template: 't.md',
  output: {
    target: 'draft',
    channel: 'file',
    idempotencyKey: 'bericht:{date}',
  },
  ...over,
});

const template = [
  '## Bericht {{period}}',
  '{{#liste}}',
  '- {{tag}} {{text}} ({{zahl}}) {{person}}',
  '{{/liste}}',
  '{{^liste}}',
  'Nichts.',
  '{{/liste}}',
  '',
].join('\n');

const loadedOf = (value: Record<string, unknown>): LoadedRoutine => {
  const checked = checkRoutine(value);
  if (!checked.ok) throw new Error(`invalid: ${checked.code}`);
  const parsed = parseTemplate(
    template,
    checked.routine.generate?.blocks ?? {},
  );
  if (!parsed.ok) throw new Error('invalid template');
  return {
    routine: checked.routine,
    prompt: 'Prompt.',
    template: parsed.template,
  };
};

const entry = (over: Record<string, unknown> = {}) => ({
  routine: 'bericht',
  credential: 'runner',
  modelRedaction: 'strict' as const,
  target: { kind: 'wiki_category' as const, id: 7, name: 'Berichte' },
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 1,
  maxPerDay: 2,
  ...over,
});

const policyOf = (entries: readonly unknown[] = []): Policy =>
  ({
    schema: 'policy.v1',
    interactive: { readBudgetPerDay: 200, targets: [] },
    unattended: entries,
  }) as unknown as Policy;

const context = (policy = policyOf()) => ({
  tool: (name: string) => tools[name],
  policy,
  models: new Set(['default']),
});

const wikiOutput = {
  target: 'wiki',
  tool: 'ct_wiki_page_append_section',
  scope: { category: 'Berichte', page: 'Auswertung' },
  idempotencyKey: 'bericht:{isoWeek}',
};

describe('preparing a run', () => {
  it('settles the level, the target and the account', () => {
    const prepared = prepareRun(
      loadedOf(routineValue({ output: wikiOutput })),
      context(policyOf([entry({ modelRedaction: 'standard' })])),
    );
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.run.redaction).toBe('standard');
    expect(prepared.run.credential).toBe('runner');
    expect(prepared.run.target?.target.name).toBe('Berichte');
    expect(prepared.run.inputs.map((input) => input.facts.list)).toEqual([
      'events',
      'assignments',
    ]);
  });

  it('takes a target named as its page', () => {
    const prepared = prepareRun(
      loadedOf(routineValue({ output: wikiOutput })),
      context(
        policyOf([
          entry({
            target: {
              kind: 'wiki_page',
              categoryId: 7,
              guid: 'x',
              name: 'Auswertung',
            },
          }),
        ]),
      ),
    );
    expect(prepared.ok).toBe(true);
  });

  it('starts a draft to a file without an entry, at strict and with the account of the runner', () => {
    const prepared = prepareRun(loadedOf(routineValue()), context());
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.run.redaction).toBe('strict');
    expect(prepared.run).not.toHaveProperty('credential');
    expect(prepared.run).not.toHaveProperty('target');
  });

  const inputs = routineValue().inputs;
  it.each<[string, Record<string, unknown>, string, string | undefined]>([
    [
      'a tool the server does not have',
      { inputs: [{ ...inputs[0], tool: 'ct_none' }] },
      'run_tool_unknown',
      'inputs[0].tool',
    ],
    [
      'a tool not stable for routines',
      { inputs: [{ ...inputs[0], tool: 'ct_whoami' }] },
      'run_tool_unfit',
      'inputs[0].tool',
    ],
    [
      'a write tool',
      { inputs: [{ ...inputs[0], tool: 'ct_write' }] },
      'run_tool_unfit',
      'inputs[0].tool',
    ],
    [
      'a tool that never runs unattended',
      { inputs: [{ ...inputs[0], tool: 'ct_never' }] },
      'run_tool_unfit',
      'inputs[0].tool',
    ],
    [
      'a parameter the tool does not take',
      { inputs: [{ ...inputs[0], params: { tag: 'x' } }] },
      'run_param_unknown',
      'inputs[0].params.tag',
    ],
    [
      'a relative day too far away',
      { inputs: [{ ...inputs[0], params: { to: '+400d' } }] },
      'run_param_days',
      'inputs[0].params.to',
    ],
    [
      'a field an entry does not have',
      {
        inputs: [
          inputs[0],
          { ...inputs[1], params: { eventId: { field: 'calendarId' } } },
        ],
      },
      'run_field_unknown',
      'inputs[1].params.eventId',
    ],
    [
      'a model without a provider',
      {
        generate: { ...routineValue().generate, model: 'lang' },
      },
      'run_model_unknown',
      'generate.model',
    ],
    [
      'a target in ChurchTools without an entry',
      { output: wikiOutput },
      'run_target_unlisted',
      'output.scope',
    ],
  ])('refuses %s', (_case, change, code, field) => {
    expect(prepareRun(loadedOf(routineValue(change)), context())).toEqual({
      ok: false,
      code,
      field,
    });
  });

  it('refuses two accounts for one routine and an entry for another tool', () => {
    expect(
      prepareRun(
        loadedOf(routineValue()),
        context(policyOf([entry(), entry({ credential: 'zweites' })])),
      ),
    ).toEqual({ ok: false, code: 'run_credential_mixed' });
    expect(
      prepareRun(
        loadedOf(routineValue({ output: wikiOutput })),
        context(policyOf([entry({ tools: ['ct_wiki_page_create'] })])),
      ),
    ).toMatchObject({ ok: false, code: 'run_target_unlisted' });
  });

  it('prepares a preview of a target in the wiki before its entry, with every other check', () => {
    const prepared = prepareRun(
      loadedOf(routineValue({ output: wikiOutput })),
      {
        ...context(),
        preview: true,
      },
    );
    expect(prepared).toMatchObject({
      ok: true,
      run: { preview: true, redaction: 'strict', entries: [] },
    });
    if (!prepared.ok) throw new Error(prepared.code);
    expect(prepared.run.target).toBeUndefined();
    expect(prepared.run.credential).toBeUndefined();
    // The other checks hold for a preview as well.
    expect(
      prepareRun(
        loadedOf(
          routineValue({
            output: wikiOutput,
            generate: { ...routineValue().generate, model: 'lang' },
          }),
        ),
        { ...context(), preview: true },
      ),
    ).toEqual({
      ok: false,
      code: 'run_model_unknown',
      field: 'generate.model',
    });
    // With the entry, the preview takes its target and its account.
    const listed = prepareRun(loadedOf(routineValue({ output: wikiOutput })), {
      ...context(policyOf([entry()])),
      preview: true,
    });
    expect(listed).toMatchObject({
      ok: true,
      run: {
        preview: true,
        credential: 'runner',
        target: { routine: 'bericht' },
      },
    });
    // Without the option nothing is marked as a preview.
    const run = prepareRun(loadedOf(routineValue()), context());
    expect(run).toMatchObject({ ok: true });
    expect(run.ok && 'preview' in run.run).toBe(false);
  });

  it('refuses a routine with the checks of the core until they are built', () => {
    const rest: Record<string, unknown> = { ...routineValue() };
    delete rest['generate'];
    delete rest['inputs'];
    const checked = checkRoutine({
      ...rest,
      checks: [{ check: 'brokenLinks', maxItems: 5 }],
    });
    if (!checked.ok) throw new Error(checked.code);
    const parsed = parseTemplate(
      '{{#brokenLinks}}\n- {{page}}\n{{/brokenLinks}}\n',
      {
        brokenLinks: {
          maxItems: 5,
          fields: { page: { type: 'text', maxLength: 255 } },
        },
      },
    );
    if (!parsed.ok) throw new Error('invalid template');
    const checks: LoadedRoutine = {
      routine: checked.routine,
      template: parsed.template,
    };
    expect(prepareRun(checks, context())).toEqual({
      ok: false,
      code: 'run_checks_pending',
      field: 'checks',
    });
  });
});

describe('the schema of an answer', () => {
  const blocks = loadedOf(routineValue()).routine.generate?.blocks ?? {};
  const pseudonym = `p1_${'a'.repeat(39)}`;
  const valid = {
    liste: [{ text: 'Probe', tag: '2026-11-16', zahl: 3, person: pseudonym }],
  };

  it('takes exactly the blocks and fields, in strict a pseudonym for a person', async () => {
    const spec = outputSpecOf(blocks, 'strict');
    expect(spec.name).toBe('routine_output');
    expect(spec.jsonSchema).not.toHaveProperty('$schema');
    const check = (value: unknown) =>
      Promise.resolve(spec.validate['~standard'].validate(value));
    await expect(check(valid)).resolves.toEqual({ value: valid });
    for (const wrong of [
      { liste: [{ ...valid.liste[0], person: 12 }] },
      { liste: [{ ...valid.liste[0], tag: '2026-02-30' }] },
      { liste: [{ ...valid.liste[0], text: 'Zeile\neins' }] },
      { liste: [{ ...valid.liste[0], zahl: 10 }] },
      { liste: [{ ...valid.liste[0], extra: 1 }] },
      { liste: [], mehr: [] },
      { liste: Array.from({ length: 4 }, () => valid.liste[0]) },
    ]) {
      expect((await check(wrong)).issues).toBeDefined();
    }
  });

  it('takes an ID for a person in standard', async () => {
    const spec = outputSpecOf(blocks, 'standard');
    const result = await Promise.resolve(
      spec.validate['~standard'].validate({
        liste: [{ ...valid.liste[0], person: 12 }],
      }),
    );
    expect(result.issues).toBeUndefined();
  });
});

describe('reading the inputs', () => {
  const trigger: Trigger = {
    at: Date.UTC(2026, 10, 9, 5),
    period: { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' },
  };
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const prepared = (): PreparedRun => {
    const result = prepareRun(loadedOf(routineValue()), context());
    if (!result.ok) throw new Error(result.code);
    return result.run;
  };
  const ok = (
    data: Readonly<Record<string, unknown>>,
    entries: number,
    more = false,
    persons: Record<string, string> = {},
  ): RunCallOutcome => {
    const outcome = redactedOutcome(data);
    if (!outcome.ok) throw new Error('no data');
    return { ok: true, data: outcome.data, entries, more, persons };
  };

  it('pages, calls once per entry of the source and keeps a name over an empty one', async () => {
    const calls: unknown[] = [];
    const read: RunRead = (tool, input, maxEntries) => {
      calls.push({ tool, input, maxEntries });
      if (tool === 'ct_events_list') {
        return Promise.resolve(
          input['page'] === 1
            ? ok({ events: [{ id: 1 }, { id: 2 }], more: true }, 2, true)
            : ok({ events: [{ id: null }] }, 1),
        );
      }
      return Promise.resolve(
        ok(
          { assignments: [] },
          0,
          false,
          input['eventId'] === 1 ? { p: '' } : { p: 'Max Muster' },
        ),
      );
    };
    const result = await readInputs(
      prepared(),
      trigger,
      read,
      log,
      new AbortController().signal,
    );
    if (!result.ok) throw new Error(result.code);
    expect(calls).toEqual([
      {
        tool: 'ct_events_list',
        input: { from: '2026-11-09', to: '2026-11-23', page: 1 },
        maxEntries: 3,
      },
      {
        tool: 'ct_events_list',
        input: { from: '2026-11-09', to: '2026-11-23', page: 2 },
        maxEntries: 1,
      },
      // The third event has no ID, so it gets no call.
      {
        tool: 'ct_services_get_assignments',
        input: { eventId: 1, page: 1 },
        maxEntries: 5,
      },
      {
        tool: 'ct_services_get_assignments',
        input: { eventId: 2, page: 1 },
        maxEntries: 5,
      },
    ]);
    expect(result.calls).toBe(4);
    expect([...result.persons]).toEqual([['p', 'Max Muster']]);
    expect(result.inputs.map((input) => input.values.length)).toEqual([2, 2]);
  });

  it('ends with the code of a failed read and whether it may pass', async () => {
    const read: RunRead = () =>
      Promise.resolve({ ok: false, code: 'rate_limited', transient: true });
    await expect(
      readInputs(prepared(), trigger, read, log, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      transient: true,
      input: 'termine',
    });
  });

  it('ends for good when an input would need more calls than allowed', async () => {
    let calls = 0;
    const read: RunRead = () => {
      calls += 1;
      return Promise.resolve(ok({ events: [] }, 0, true));
    };
    await expect(
      readInputs(prepared(), trigger, read, log, new AbortController().signal),
    ).resolves.toMatchObject({
      ok: false,
      code: 'run_calls_exhausted',
      transient: false,
    });
    expect(calls).toBe(runReadLimits.callsPerInput);
  });

  it('counts a day back from the trigger', async () => {
    const value = routineValue();
    const back = loadedOf({
      ...value,
      inputs: [
        { ...value.inputs[0], params: { from: '-7d', to: '+0d', page: 2 } },
      ],
    });
    const result = prepareRun(back, context());
    if (!result.ok) throw new Error(result.code);
    const seen: unknown[] = [];
    const read: RunRead = (_tool, input) => {
      seen.push(input);
      return Promise.resolve(ok({ events: [] }, 0));
    };
    await readInputs(
      result.run,
      trigger,
      read,
      log,
      new AbortController().signal,
    );
    expect(seen).toEqual([{ from: '2026-11-02', to: '2026-11-09', page: 2 }]);
  });
});

describe('the check of an answer and the template', () => {
  const blocks = loadedOf(routineValue()).routine.generate?.blocks ?? {};
  const answer = {
    liste: [{ text: '*Probe*', tag: '2026-11-16', zahl: 3, person: 'p-12' }],
  };

  it('gives every value as plain text, a day as DD.MM.YYYY and a person by name', () => {
    const checked = checkAnswer(
      answer,
      blocks,
      new Map([['p-12', '']]),
      new Set(),
    );
    if (!checked.ok) throw new Error('refused');
    expect(checked.blocks['liste']).toEqual([
      { text: '*Probe*', tag: '16.11.2026', zahl: '3', person: unnamedPerson },
    ]);
    const section = renderSection(
      loadedOf(routineValue()).template,
      checked.blocks,
      '2026-11-09',
    );
    expect(section).toBe(
      // The text of the template stays as it is, every value is escaped.
      '## Bericht 2026\\-11\\-09\n- 16\\.11\\.2026 \\*Probe\\* (3) \\(ohne Namen\\)\n',
    );
  });

  it('renders the text for an empty block', () => {
    const checked = checkAnswer({ liste: [] }, blocks, new Map(), new Set());
    if (!checked.ok) throw new Error('refused');
    expect(
      renderSection(loadedOf(routineValue()).template, checked.blocks, 'W'),
    ).toBe('## Bericht W\nNichts.\n');
  });

  it('counts every field that fails, with the reasons of the content policy', () => {
    expect(
      checkAnswer(
        {
          liste: [
            { ...answer.liste[0], text: 'siehe gemeinde.example', person: 'x' },
          ],
        },
        blocks,
        new Map(),
        new Set(),
      ),
    ).toEqual({
      ok: false,
      fields: 2,
      unknownPerson: true,
      violations: ['webAddress'],
    });
  });
});

describe('the limits of the reads and the names of persons', () => {
  const trigger: Trigger = {
    at: Date.UTC(2026, 10, 9, 5),
    period: { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' },
  };
  const quiet: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const list = facts({
    params: ['id'],
    list: 'items',
    entryFields: ['id'],
    paged: false,
  });
  const listContext = {
    tool: () => list,
    policy: policyOf(),
    models: new Set(['default']),
  };
  const items = (count: number) =>
    Array.from({ length: count }, (_value, index) => ({ id: index + 1 }));
  const outcomeOf = (
    data: Readonly<Record<string, unknown>>,
    entries: number,
  ): RunCallOutcome => {
    const outcome = redactedOutcome(data);
    if (!outcome.ok) throw new Error('no data');
    return { ok: true, data: outcome.data, entries, more: false, persons: {} };
  };
  const preparedWith = (inputs: readonly Record<string, unknown>[]) => {
    const result = prepareRun(loadedOf(routineValue({ inputs })), listContext);
    if (!result.ok) throw new Error(result.code);
    return result.run;
  };

  it('ends a run for good when a source has entries left beyond maxItems', async () => {
    const run = preparedWith([
      { name: 'quelle', tool: 'ct_list', maxItems: 5 },
      {
        name: 'je',
        tool: 'ct_list',
        forEach: 'quelle',
        params: { id: { field: 'id' } },
        maxItems: 2,
      },
    ]);
    let calls = 0;
    const read: RunRead = (_tool, input) => {
      calls += 1;
      return Promise.resolve(
        input['id'] === undefined
          ? outcomeOf({ items: items(5) }, 5)
          : outcomeOf({ items: items(1) }, 1),
      );
    };
    await expect(
      readInputs(run, trigger, read, quiet, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: 'run_items_exhausted',
      transient: false,
      input: 'je',
    });
    expect(calls).toBe(3);
  });

  it('ends a run for good after 400 calls over all its inputs', async () => {
    const each = (name: string) => ({
      name,
      tool: 'ct_list',
      forEach: 'quelle',
      params: { id: { field: 'id' } },
      maxItems: 200,
    });
    const run = preparedWith([
      { name: 'quelle', tool: 'ct_list', maxItems: 199 },
      each('eins'),
      each('zwei'),
      each('drei'),
    ]);
    let calls = 0;
    const read: RunRead = (_tool, input) => {
      calls += 1;
      return Promise.resolve(
        input['id'] === undefined
          ? outcomeOf({ items: items(199) }, 199)
          : outcomeOf({ items: [] }, 0),
      );
    };
    await expect(
      readInputs(run, trigger, read, quiet, new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      code: 'run_calls_exhausted',
      transient: false,
      input: 'drei',
    });
    expect(calls).toBe(runReadLimits.callsPerRun);
  });

  it('refuses a relative day of five digits like one too far away', () => {
    const value = routineValue();
    expect(
      prepareRun(
        loadedOf({
          ...value,
          inputs: [{ ...value.inputs[0], params: { to: '+99999d' } }],
        }),
        context(),
      ),
    ).toMatchObject({ ok: false, code: 'run_param_days' });
  });

  it('puts a name of ChurchTools through the content policy like a text', () => {
    const blocks = loadedOf(routineValue()).routine.generate?.blocks ?? {};
    const answer = {
      liste: [{ text: 'Probe', tag: '2026-11-16', zahl: 3, person: 'p' }],
    };
    const nameOf = (name: string) => {
      const checked = checkAnswer(
        answer,
        blocks,
        new Map([['p', name]]),
        new Set(),
      );
      return checked.ok ? checked.blocks['liste']?.[0]?.['person'] : checked;
    };
    // The normal form turns signs of full width into those of ASCII, which
    // the template then escapes.
    expect(nameOf('＊＊Max＊＊')).toBe('**Max**');
    expect(nameOf('Max\n\n# Neu')).toMatchObject({
      ok: false,
      violations: ['unsupported'],
    });
    expect(nameOf('Max [ecclium: 1 hidden characters removed]')).toMatchObject({
      ok: false,
    });
  });
});

describe('a run that ends at the section', () => {
  it('refuses a section the template makes a web address in', async () => {
    const checked = checkRoutine(routineValue());
    if (!checked.ok) throw new Error(checked.code);
    const parsed = parseTemplate(
      'Mehr unter gemeinde.example\n{{#liste}}\n- {{text}}\n{{/liste}}\n',
      checked.routine.generate?.blocks ?? {},
    );
    if (!parsed.ok) throw new Error(parsed.code);
    const prepared = prepareRun(
      {
        routine: checked.routine,
        prompt: 'Prompt.',
        template: parsed.template,
      },
      context(),
    );
    if (!prepared.ok) throw new Error(prepared.code);
    const warned: string[] = [];
    const log: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (event) => {
        warned.push(event);
      },
      error: () => undefined,
    };
    const read: RunRead = () => {
      const outcome = redactedOutcome({ events: [] });
      if (!outcome.ok) throw new Error('no data');
      return Promise.resolve({
        ok: true,
        data: outcome.data,
        entries: 0,
        more: false,
        persons: {},
      });
    };
    const model = guardModelProvider(
      createMockModelProvider({
        kind: 'obedient',
        respond: () => ({ liste: [] }),
      }).provider,
    );
    const result = await executeRun(
      prepared.run,
      {
        at: Date.UTC(2026, 10, 9, 5),
        period: { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' },
      },
      {
        read,
        model,
        policy: policyOf(),
        log,
        clock: { now: () => Date.UTC(2026, 10, 9, 5) },
      },
      new AbortController().signal,
    );
    expect(result).toEqual({
      kind: 'failed',
      step: 'content',
      code: 'run_content_refused',
      final: true,
      violations: ['webAddress'],
    });
    expect(warned).toEqual(['run_section_refused']);
  });

  it('names a breach of the content policy before an unknown person in the same answer', async () => {
    const prepared = prepareRun(loadedOf(routineValue()), context());
    if (!prepared.ok) throw new Error(prepared.code);
    const read: RunRead = () => {
      const outcome = redactedOutcome({ events: [] });
      if (!outcome.ok) throw new Error('no data');
      return Promise.resolve({
        ok: true,
        data: outcome.data,
        entries: 0,
        more: false,
        persons: {},
      });
    };
    const model = guardModelProvider(
      createMockModelProvider({
        kind: 'obedient',
        respond: () => ({
          liste: [
            {
              text: 'siehe gemeinde.example',
              tag: '2026-11-16',
              zahl: 3,
              // A pseudonym of the right form that is none of the data.
              person: `p1_${'a'.repeat(39)}`,
            },
          ],
        }),
      }).provider,
    );
    const result = await executeRun(
      prepared.run,
      {
        at: Date.UTC(2026, 10, 9, 5),
        period: { isoWeek: '2026-W46', date: '2026-11-09', month: '2026-11' },
      },
      {
        read,
        model,
        policy: policyOf(),
        log: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        clock: { now: () => Date.UTC(2026, 10, 9, 5) },
      },
      new AbortController().signal,
    );
    // Refused with its reasons, so that the audit says denied (ADR 0030).
    expect(result).toEqual({
      kind: 'failed',
      step: 'answer',
      code: 'run_content_refused',
      final: true,
      violations: ['webAddress'],
    });
  });
});
