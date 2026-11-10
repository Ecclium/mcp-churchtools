import {
  type AttemptStart,
  type DueCheck,
  type GuardedModel,
  type GuardedModelRequest,
  guardModelProvider,
  type Policy,
  type RunCallOutcome,
  type RunToolFacts,
  type RunWriteOutcome,
  type Trigger,
} from '@ecclium/mcp-churchtools-core';
import type {
  Logger,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createMockModelProvider,
  mockProviderInfo,
  redactedOutcome,
} from '@ecclium/mcp-churchtools-testkit';
import {
  checkRoutine,
  parseTemplate,
  type PreparedRun,
  prepareRun,
  type RunWriteCall,
} from '@ecclium/mcp-churchtools-workflows';
import { describe, expect, it } from 'vitest';

import {
  type DraftCall,
  type DraftResult,
  type OpenedRun,
  type OpenRunResult,
  type PassOptions,
  previewRoutine,
  type RoutineReport,
  type RunEndLine,
  type RunnerPorts,
  type RunNotice,
  runByHand,
  runDue,
} from './pass.js';

// The pass of the runner (ADR 0033, ADR 0034) on recording stand-ins of
// every port, with the real engine of `workflows` in between: a routine
// prepared from its file, a read port, a model behind the guard of the
// core and a write port. Every stand-in writes what it was asked into one
// list, so that a test shows the order of the steps and what never
// happened.

const week = 7 * 86_400_000;
const begin = Date.UTC(2026, 10, 9, 6);

const trigger: Trigger = Object.freeze({
  at: Date.UTC(2026, 10, 9, 5),
  period: Object.freeze({
    isoWeek: '2026-W46',
    date: '2026-11-09',
    month: '2026-11',
  }),
});

const laterTrigger: Trigger = Object.freeze({
  at: Date.UTC(2026, 10, 16, 5),
  period: Object.freeze({
    isoWeek: '2026-W47',
    date: '2026-11-16',
    month: '2026-11',
  }),
});

const dueAt = (at: Trigger = trigger): DueCheck => ({
  status: 'due',
  trigger: at,
  next: at.at + week,
});

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const facts: RunToolFacts = {
  capability: 'read',
  routineStable: true,
  unattended: 'policy',
  params: ['from', 'to'],
  list: 'events',
  entryFields: ['id', 'name'],
  paged: false,
};

const policyOf = (entries: readonly unknown[]): Policy =>
  ({
    schema: 'policy.v1',
    interactive: { readBudgetPerDay: 200, targets: [] },
    unattended: entries,
  }) as unknown as Policy;

const template = [
  '## Bericht {{period}}',
  '{{#liste}}',
  '- {{text}}',
  '{{/liste}}',
  '{{^liste}}',
  'Nichts.',
  '{{/liste}}',
  '',
].join('\n');

type Target = 'wiki' | 'draft';

const routineOf = (id: string, target: Target) => ({
  schema: 'routine.v1',
  id,
  schedule: '0 6 * * MON',
  inputs: [
    {
      name: 'termine',
      tool: 'ct_events_list',
      params: { from: '+0d', to: '+14d' },
      maxItems: 3,
    },
  ],
  generate: {
    prompt: 'p.md',
    model: 'default',
    output: {
      blocks: {
        liste: {
          maxItems: 3,
          fields: { text: { type: 'text', maxLength: 40 } },
        },
      },
    },
  },
  template: 't.md',
  output:
    target === 'wiki'
      ? {
          target: 'wiki',
          tool: 'ct_wiki_page_append_section',
          scope: { category: 'Berichte', page: 'Auswertung' },
          idempotencyKey: `${id}:{isoWeek}`,
        }
      : { target: 'draft', channel: 'file', idempotencyKey: `${id}:{date}` },
});

// The entry of the policy that allows a routine its page in the wiki.
const entryOf = (id: string) => ({
  routine: id,
  credential: 'berichte',
  modelRedaction: 'strict',
  target: { kind: 'wiki_category', id: 7, name: 'Berichte' },
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 1,
  maxPerDay: 2,
});

// A routine as the composition root prepares it: into the wiki with its
// entry of the policy, as a draft into a file without one, or for a
// preview, which needs no entry.
const prepared = (id: string, target: Target, preview = false): PreparedRun => {
  const checked = checkRoutine(routineOf(id, target));
  if (!checked.ok) throw new Error(`invalid routine: ${checked.code}`);
  const parsed = parseTemplate(
    template,
    checked.routine.generate?.blocks ?? {},
  );
  if (!parsed.ok) throw new Error('invalid template');
  const result = prepareRun(
    { routine: checked.routine, prompt: 'Prompt.', template: parsed.template },
    {
      tool: (name) => (name === 'ct_events_list' ? facts : undefined),
      policy: policyOf(target === 'wiki' && !preview ? [entryOf(id)] : []),
      models: new Set(['default']),
      ...(preview ? { preview: true } : {}),
    },
  );
  if (!result.ok) throw new Error(`not prepared: ${result.code}`);
  return result.run;
};

const emptyRead = (): RunCallOutcome => {
  const outcome = redactedOutcome({ events: [] });
  if (!outcome.ok) throw new Error('no data');
  return { ok: true, data: outcome.data, entries: 0, more: false, persons: {} };
};

const pageTarget = {
  kind: 'wiki_page' as const,
  key: '7/0000000a-0000-4000-8000-000000000001',
};

const verified: RunWriteOutcome = {
  ok: true,
  state: 'verified',
  target: pageTarget,
  version: 4,
};

const answering = (value: unknown): ModelProvider =>
  createMockModelProvider({ kind: 'obedient', respond: () => value }).provider;

const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
  });

// A model that ignores its deadline: it answers, and validly, only once
// its signal aborted, as a vendor whose answer arrives just too late.
const lateProvider = (): ModelProvider => ({
  info: mockProviderInfo,
  nativeStructuredOutput: true,
  generate<T>(
    _request: ModelRequest<T>,
    signal: AbortSignal,
  ): Promise<ModelResult<T>> {
    return abortOf(signal).then(() => ({
      value: { liste: [] } as T,
      attempts: 1 as const,
    }));
  },
});

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const fault = (): never => {
  throw new Error('A port failed.');
};

// The names of the steps of one routine, as the stand-ins record them.
const steps = (id: string, ...names: readonly string[]): string[] =>
  names.map((name) => `${name}:${id}`);

const dueWiki = [
  'due',
  'lock',
  'due',
  'open',
  'start',
  'kill',
  'read',
  'model',
  'write',
  'close-trigger',
  'end',
  'notify',
  'close-run',
  'release',
] as const;

const dueDraft = dueWiki.map((name) => (name === 'write' ? 'draft' : name));

// What a test changes on the stand-ins; anything left out answers as a
// healthy port does.
interface Script {
  readonly due?: (id: string, look: number) => DueCheck;
  readonly last?: (id: string) => Trigger;
  readonly lock?: (id: string) => 'held' | 'busy' | 'failed';
  readonly halted?: boolean;
  readonly readOnly?: boolean;
  readonly killSwitch?: (id: string) => 'on' | 'off' | 'unknown';
  readonly open?: (id: string) => OpenRunResult | undefined;
  readonly start?: (id: string) => AttemptStart;
  readonly close?: (id: string) => boolean;
  readonly end?: (id: string) => boolean;
  readonly notify?: (id: string) => boolean;
  readonly draft?: (call: DraftCall) => DraftResult;
  readonly read?: (id: string, signal: AbortSignal) => Promise<RunCallOutcome>;
  readonly provider?: (id: string) => ModelProvider;
  readonly write?: (
    id: string,
    count: number,
    signal: AbortSignal,
  ) => Promise<RunWriteOutcome>;
}

const setup = (script: Script = {}) => {
  const order: string[] = [];
  const lines: RunEndLine[] = [];
  const notices: RunNotice[] = [];
  const drafts: DraftCall[] = [];
  const writeCalls: { call: RunWriteCall; signal: AbortSignal }[] = [];
  const starts: Trigger[] = [];
  const closes: Trigger[] = [];
  const looks = new Map<string, number>();
  let now = begin;
  const idOf = (run: PreparedRun): string => run.loaded.routine.id;

  const openRun = (id: string): OpenedRun => {
    const inner = guardModelProvider(
      (script.provider ?? (() => answering({ liste: [] })))(id),
    );
    const model: GuardedModel = {
      info: inner.info,
      nativeStructuredOutput: inner.nativeStructuredOutput,
      generate<T>(
        request: GuardedModelRequest<T>,
        signal: AbortSignal,
      ): Promise<ModelResult<T>> {
        order.push(`model:${id}`);
        return inner.generate(request, signal);
      },
    };
    let written = 0;
    return {
      runId: `run-${id}`,
      read: (_tool, _input, _maxEntries, signal) => {
        order.push(`read:${id}`);
        return script.read === undefined
          ? Promise.resolve(emptyRead())
          : script.read(id, signal);
      },
      write: (call, signal) => {
        order.push(`write:${id}`);
        writeCalls.push({ call, signal });
        written += 1;
        return script.write === undefined
          ? Promise.resolve(verified)
          : script.write(id, written, signal);
      },
      model,
      log: quiet,
      end: (line) => {
        order.push(`end:${id}`);
        lines.push(line);
        return script.end?.(id) ?? true;
      },
      close: () => {
        order.push(`close-run:${id}`);
        return Promise.resolve();
      },
    };
  };

  const ports: RunnerPorts = {
    schedule: {
      due: (run) => {
        const id = idOf(run);
        order.push(`due:${id}`);
        const look = (looks.get(id) ?? 0) + 1;
        looks.set(id, look);
        return Promise.resolve().then(() => script.due?.(id, look) ?? dueAt());
      },
      last: (run) => {
        const id = idOf(run);
        order.push(`last:${id}`);
        return script.last?.(id) ?? trigger;
      },
      start: (run, at) => {
        const id = idOf(run);
        order.push(`start:${id}`);
        starts.push(at);
        return Promise.resolve().then(
          (): AttemptStart => script.start?.(id) ?? { ok: true, attempt: 1 },
        );
      },
      close: (run, at) => {
        const id = idOf(run);
        order.push(`close-trigger:${id}`);
        closes.push(at);
        return Promise.resolve().then(() => script.close?.(id) ?? true);
      },
    },
    locks: {
      acquire: (id) => {
        order.push(`lock:${id}`);
        const kind = script.lock?.(id) ?? 'held';
        return kind === 'held'
          ? {
              kind,
              release: () => {
                order.push(`release:${id}`);
              },
            }
          : { kind };
      },
    },
    writesHalted: () => script.halted ?? false,
    readOnly: script.readOnly ?? false,
    killSwitch: (id) => {
      order.push(`kill:${id}`);
      return script.killSwitch?.(id) ?? 'on';
    },
    open: (run) => {
      const id = idOf(run);
      order.push(`open:${id}`);
      return script.open?.(id) ?? { ok: true, run: openRun(id) };
    },
    draft: (call) => {
      order.push(`draft:${call.routineId}`);
      drafts.push(call);
      return script.draft?.(call) ?? { ok: true };
    },
    notify: (run, notice) => {
      const id = idOf(run);
      order.push(`notify:${id}`);
      notices.push(notice);
      return script.notify?.(id) ?? true;
    },
    policy: policyOf([]),
    clock: { now: () => now },
  };

  return {
    ports,
    order,
    lines,
    notices,
    drafts,
    writeCalls,
    starts,
    closes,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const options = (over: Partial<PassOptions> = {}): PassOptions => ({
  signal: new AbortController().signal,
  maxRunMs: 60_000,
  ...over,
});

// The section of an empty answer, as the content policy of the core gives
// it back after its check.
const emptySection = (period: string): string =>
  `## Bericht ${period}\n\nNichts.\n`;

describe('a pass over the routines that are due', () => {
  it('runs them in the order of their IDs, one after the other', async () => {
    const h = setup({
      // A read that waits: a second routine that began early would show
      // its steps before the first ended.
      read: async (id) => {
        await delay(5);
        h.order.push(`read-done:${id}`);
        return emptyRead();
      },
    });
    const pass = await runDue(
      [
        prepared('charlie', 'draft'),
        prepared('alpha', 'wiki'),
        prepared('bravo', 'draft'),
      ],
      h.ports,
      options(),
    );
    const withReadDone = (id: string, names: readonly string[]) =>
      steps(id, ...names).flatMap((name) =>
        name === `read:${id}` ? [name, `read-done:${id}`] : [name],
      );
    expect(h.order).toEqual([
      ...withReadDone('alpha', dueWiki),
      ...withReadDone('bravo', dueDraft),
      ...withReadDone('charlie', dueDraft),
    ]);
    expect(pass.routines.map((done) => [done.routineId, done.status])).toEqual([
      ['alpha', 'ran'],
      ['bravo', 'ran'],
      ['charlie', 'ran'],
    ]);
    expect(pass.routines.map((done) => done.outcome?.result)).toEqual([
      'written',
      'drafted',
      'drafted',
    ]);
    expect(pass.severity).toBe('ok');
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(pass.routines)).toBe(true);
    expect(pass.routines.every((done) => Object.isFrozen(done))).toBe(true);
  });

  it.each<DueCheck>([
    { status: 'closed', trigger, next: trigger.at + week },
    { status: 'waiting', trigger, next: trigger.at + week },
    { status: 'exhausted', trigger, next: trigger.at + week },
    { status: 'none', next: trigger.at + week },
  ])('takes no lock for a routine that is $status', async (check) => {
    const h = setup({ due: () => check });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines).toEqual([
      { routineId: 'alpha', status: 'not_due', severity: 'ok' },
    ]);
    expect(pass.severity).toBe('ok');
    expect(h.order).toEqual(['due:alpha']);
  });

  it('goes on with the next routine when the memory of runs is unavailable', async () => {
    const h = setup({
      due: (id) =>
        id === 'alpha' ? { status: 'unavailable', next: trigger.at } : dueAt(),
    });
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options(),
    );
    expect(pass.routines[0]).toEqual({
      routineId: 'alpha',
      status: 'unavailable',
      severity: 'temporary',
    });
    expect(pass.routines[1]).toMatchObject({ status: 'ran', severity: 'ok' });
    expect(pass.severity).toBe('temporary');
    expect(h.order).toEqual(['due:alpha', ...steps('bravo', ...dueDraft)]);
  });

  it('skips a routine whose lock another process holds, without a try', async () => {
    const h = setup({ lock: () => 'busy' });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass).toEqual({
      routines: [{ routineId: 'alpha', status: 'busy', severity: 'ok' }],
      severity: 'ok',
    });
    expect(h.order).toEqual(['due:alpha', 'lock:alpha']);
  });

  it('ends a routine as a fault of the setup when its lock cannot be used', async () => {
    const h = setup({ lock: () => 'failed' });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines).toEqual([
      { routineId: 'alpha', status: 'lock_failed', severity: 'config' },
    ]);
    expect(pass.severity).toBe('config');
    expect(h.order).toEqual(['due:alpha', 'lock:alpha']);
  });

  it('looks again under the lock and stops when the trigger closed in between', async () => {
    const h = setup({
      due: (_id, look) =>
        look === 1
          ? dueAt()
          : { status: 'closed', trigger, next: trigger.at + week },
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines).toEqual([
      { routineId: 'alpha', status: 'not_due', severity: 'ok' },
    ]);
    expect(h.order).toEqual(steps('alpha', 'due', 'lock', 'due', 'release'));
  });

  it('ends as unavailable when the second look gets no answer, with the lock released', async () => {
    const h = setup({
      due: (_id, look) =>
        look === 1 ? dueAt() : { status: 'unavailable', next: trigger.at },
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines).toEqual([
      { routineId: 'alpha', status: 'unavailable', severity: 'temporary' },
    ]);
    expect(h.order).toEqual(steps('alpha', 'due', 'lock', 'due', 'release'));
  });

  it('serves the trigger of the second look', async () => {
    const h = setup({
      due: (_id, look) => (look === 1 ? dueAt() : dueAt(laterTrigger)),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]?.period).toBe('2026-W47');
    expect(h.starts).toEqual([laterTrigger]);
    expect(h.closes).toEqual([laterTrigger]);
    expect(h.lines[0]?.period).toBe('2026-W47');
    expect(h.writeCalls[0]?.call.period).toBe('2026-W47');
  });

  it('starts no run while writes are halted, and counts no try', async () => {
    const h = setup({ halted: true });
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options(),
    );
    expect(pass.routines).toEqual([
      {
        routineId: 'alpha',
        status: 'halted',
        severity: 'temporary',
        period: '2026-W46',
      },
      {
        routineId: 'bravo',
        status: 'halted',
        severity: 'temporary',
        period: '2026-11-09',
      },
    ]);
    expect(h.order).toEqual([
      ...steps('alpha', 'due', 'lock', 'due', 'release'),
      ...steps('bravo', 'due', 'lock', 'due', 'release'),
    ]);
  });

  it('starts no routine into the wiki while the configuration only reads, but a draft', async () => {
    const h = setup({ readOnly: true });
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options(),
    );
    expect(pass.routines[0]).toEqual({
      routineId: 'alpha',
      status: 'read_only',
      severity: 'config',
      period: '2026-W46',
    });
    expect(pass.routines[1]).toMatchObject({
      status: 'ran',
      severity: 'ok',
      outcome: { result: 'drafted' },
    });
    expect(pass.severity).toBe('config');
    expect(h.order).toEqual([
      ...steps('alpha', 'due', 'lock', 'due', 'release'),
      ...steps('bravo', ...dueDraft),
    ]);
  });

  it('leaves the trigger untouched when the run cannot be opened', async () => {
    const h = setup({
      open: () => ({ ok: false, code: 'credential_refused' }),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines).toEqual([
      {
        routineId: 'alpha',
        status: 'not_opened',
        severity: 'config',
        code: 'credential_refused',
        period: '2026-W46',
      },
    ]);
    expect(h.order).toEqual(
      steps('alpha', 'due', 'lock', 'due', 'open', 'release'),
    );
    expect(h.starts).toEqual([]);
    expect(h.closes).toEqual([]);
  });

  it.each<[AttemptStart, string, string]>([
    [{ ok: false, reason: 'waiting' }, 'not_due', 'ok'],
    [{ ok: false, reason: 'exhausted' }, 'not_due', 'ok'],
    [{ ok: false, reason: 'expired' }, 'not_due', 'ok'],
    [{ ok: false, reason: 'unavailable' }, 'unavailable', 'temporary'],
  ])(
    'closes the opened run when the try is refused with %j',
    async (start, status, severity) => {
      const h = setup({ start: () => start });
      const pass = await runDue(
        [prepared('alpha', 'wiki')],
        h.ports,
        options(),
      );
      expect(pass.routines).toEqual([
        { routineId: 'alpha', status, severity, period: '2026-W46' },
      ]);
      expect(h.order).toEqual(
        steps(
          'alpha',
          'due',
          'lock',
          'due',
          'open',
          'start',
          'close-run',
          'release',
        ),
      );
      expect(h.lines).toEqual([]);
      expect(h.notices).toEqual([]);
    },
  );

  it.each<['off' | 'unknown', Target, string]>([
    ['off', 'wiki', '2026-W46'],
    ['unknown', 'wiki', '2026-W46'],
    ['off', 'draft', '2026-11-09'],
  ])(
    'ends a run whose kill switch is %s before its first read (%s)',
    async (state, target, period) => {
      const h = setup({ killSwitch: () => state });
      const pass = await runDue(
        [prepared('alpha', target)],
        h.ports,
        options(),
      );
      expect(pass.routines[0]).toEqual({
        routineId: 'alpha',
        status: 'ran',
        severity: 'refused',
        outcome: {
          result: 'failed',
          step: 'write',
          code: 'policy_denied',
          final: true,
        },
        runId: 'run-alpha',
        period,
        attempt: 1,
        recorded: true,
        closed: true,
        notified: true,
      });
      // No read and no model: a stopped routine sends no data anywhere.
      expect(h.order).toEqual(
        steps(
          'alpha',
          'due',
          'lock',
          'due',
          'open',
          'start',
          'kill',
          'close-trigger',
          'end',
          'notify',
          'close-run',
          'release',
        ),
      );
      expect(h.lines).toEqual([
        {
          result: 'failed',
          step: 'write',
          code: 'policy_denied',
          refused: true,
          attempt: 1,
          period,
          durationMs: 0,
        },
      ]);
      expect(h.notices[0]).toMatchObject({
        result: 'failed',
        step: 'write',
        code: 'policy_denied',
      });
      expect(h.writeCalls).toEqual([]);
      expect(h.drafts).toEqual([]);
    },
  );

  it('writes a whole run into the wiki, closes the trigger and states its end without content', async () => {
    const h = setup({
      read: () => {
        h.advance(1500);
        return Promise.resolve(emptyRead());
      },
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass).toEqual({
      routines: [
        {
          routineId: 'alpha',
          status: 'ran',
          severity: 'ok',
          outcome: { result: 'written', final: true },
          runId: 'run-alpha',
          period: '2026-W46',
          attempt: 1,
          recorded: true,
          closed: true,
          notified: true,
        },
      ],
      severity: 'ok',
    });
    expect(h.order).toEqual(steps('alpha', ...dueWiki));
    expect(h.writeCalls.map((write) => write.call)).toEqual([
      {
        tool: 'ct_wiki_page_append_section',
        period: '2026-W46',
        section: emptySection('2026-W46'),
        page: { categoryId: 7, title: 'Auswertung' },
      },
    ]);
    expect(h.starts).toEqual([trigger]);
    expect(h.closes).toEqual([trigger]);
    expect(h.lines).toEqual([
      { result: 'written', attempt: 1, period: '2026-W46', durationMs: 1500 },
    ]);
    expect(h.notices).toEqual([
      {
        time: '2026-11-09T06:00:01.500Z',
        routine: 'alpha',
        period: '2026-W46',
        run: 'run-alpha',
        result: 'written',
      },
    ]);
    expect(JSON.stringify(h.notices)).not.toContain('Nichts');
    expect(h.drafts).toEqual([]);
  });

  it.each<[RunWriteOutcome, string]>([
    [{ ok: true, state: 'skipped', target: pageTarget }, 'unchanged'],
    [
      { ok: true, state: 'queued', target: pageTarget, queueId: 'q-1' },
      'queued',
    ],
  ])(
    'ends a write that is %j as %s and closes the trigger',
    async (written, result) => {
      const h = setup({ write: () => Promise.resolve(written) });
      const pass = await runDue(
        [prepared('alpha', 'wiki')],
        h.ports,
        options(),
      );
      expect(pass.routines[0]).toMatchObject({
        status: 'ran',
        severity: 'ok',
        outcome: { result, final: true },
        closed: true,
      });
      expect(h.order).toEqual(steps('alpha', ...dueWiki));
      expect(h.lines[0]).toEqual({
        result,
        attempt: 1,
        period: '2026-W46',
        durationMs: 0,
      });
    },
  );

  it('leaves the trigger open after a write a later try may pass', async () => {
    const h = setup({
      write: () =>
        Promise.resolve({
          ok: false,
          code: 'network',
          sent: true,
          transient: true,
        }),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      status: 'ran',
      severity: 'temporary',
      outcome: {
        result: 'failed',
        step: 'write',
        code: 'network',
        final: false,
      },
    });
    expect(h.order).not.toContain('close-trigger:alpha');
    expect(h.closes).toEqual([]);
    expect(h.lines).toEqual([
      {
        result: 'failed',
        step: 'write',
        code: 'network',
        attempt: 1,
        period: '2026-W46',
        durationMs: 0,
      },
    ]);
  });

  it('closes the trigger after a write that fails for good', async () => {
    const h = setup({
      write: () =>
        Promise.resolve({
          ok: false,
          code: 'not_found',
          sent: false,
          transient: false,
          page: 'missing',
        }),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'data',
      outcome: { code: 'not_found', final: true },
      closed: true,
    });
    expect(h.closes).toEqual([trigger]);
  });

  it('leaves the trigger open after a read a later try may pass, and asks no model', async () => {
    const h = setup({
      read: () =>
        Promise.resolve({ ok: false, code: 'rate_limited', transient: true }),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      status: 'ran',
      severity: 'temporary',
      outcome: {
        result: 'failed',
        step: 'input',
        code: 'rate_limited',
        final: false,
      },
    });
    expect(h.order).toEqual(
      steps(
        'alpha',
        'due',
        'lock',
        'due',
        'open',
        'start',
        'kill',
        'read',
        'end',
        'notify',
        'close-run',
        'release',
      ),
    );
  });

  it('closes the trigger after a breach of the content policy and states its reasons', async () => {
    const h = setup({
      provider: () =>
        answering({ liste: [{ text: 'siehe gemeinde.example' }] }),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      status: 'ran',
      severity: 'data',
      outcome: {
        result: 'failed',
        step: 'answer',
        code: 'run_content_refused',
        final: true,
        violations: ['webAddress'],
      },
      closed: true,
    });
    expect(h.lines).toEqual([
      {
        result: 'failed',
        step: 'answer',
        code: 'validation',
        refused: true,
        contentViolations: ['webAddress'],
        attempt: 1,
        period: '2026-W46',
        durationMs: 0,
      },
    ]);
    // The notice names the code of the engine, never the text.
    expect(h.notices[0]).toMatchObject({ code: 'run_content_refused' });
    expect(JSON.stringify(h.notices)).not.toContain('gemeinde');
    expect(h.writeCalls).toEqual([]);
    expect(h.closes).toEqual([trigger]);
  });

  it('writes the draft of a routine with the output draft', async () => {
    const h = setup();
    const pass = await runDue([prepared('bravo', 'draft')], h.ports, options());
    expect(h.drafts).toEqual([
      {
        routineId: 'bravo',
        period: '2026-11-09',
        section: emptySection('2026-11-09'),
      },
    ]);
    expect(pass.routines[0]).toMatchObject({
      status: 'ran',
      severity: 'ok',
      outcome: { result: 'drafted', final: true },
      period: '2026-11-09',
      closed: true,
    });
    expect(h.order).toEqual(steps('bravo', ...dueDraft));
    expect(h.writeCalls).toEqual([]);
  });

  it('ends a draft a kill switch refuses as refused and closes the trigger', async () => {
    const h = setup({
      draft: () => ({ ok: false, code: 'policy_denied', final: true }),
    });
    const pass = await runDue([prepared('bravo', 'draft')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'refused',
      outcome: {
        result: 'failed',
        step: 'write',
        code: 'policy_denied',
        final: true,
      },
      closed: true,
    });
    expect(h.lines[0]).toMatchObject({ code: 'policy_denied', refused: true });
  });

  it('ends a draft whose file failed as a failure of a file and leaves the trigger open', async () => {
    const h = setup({
      draft: () => ({ ok: false, code: 'internal', final: false }),
    });
    const pass = await runDue([prepared('bravo', 'draft')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'file',
      outcome: {
        result: 'failed',
        step: 'write',
        code: 'internal',
        final: false,
        file: true,
      },
    });
    expect(pass.severity).toBe('file');
    expect(h.closes).toEqual([]);
    expect(h.lines).toEqual([
      {
        result: 'failed',
        step: 'write',
        code: 'internal',
        attempt: 1,
        period: '2026-11-09',
        durationMs: 0,
      },
    ]);
  });

  it('ends at least as temporary when the audit file did not take the end line', async () => {
    const h = setup({ end: () => false });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      recorded: false,
      outcome: { result: 'written' },
    });
    // A worse severity stays.
    const refused = setup({ end: () => false, killSwitch: () => 'off' });
    const stopped = await runDue(
      [prepared('alpha', 'wiki')],
      refused.ports,
      options(),
    );
    expect(stopped.routines[0]).toMatchObject({
      severity: 'refused',
      recorded: false,
    });
  });

  it('ends as temporary when the store did not close the trigger', async () => {
    const h = setup({ close: () => false });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      closed: false,
      outcome: { result: 'written' },
    });
    expect(h.order).toEqual(steps('alpha', ...dueWiki));
  });

  it('ends at least as a failure of a file when a channel did not take the notice', async () => {
    const h = setup({ notify: () => false });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(pass.routines[0]).toMatchObject({
      severity: 'file',
      notified: false,
    });
    // A worse severity stays.
    const refused = setup({ notify: () => false, killSwitch: () => 'off' });
    const stopped = await runDue(
      [prepared('alpha', 'wiki')],
      refused.ports,
      options(),
    );
    expect(stopped.routines[0]).toMatchObject({
      severity: 'refused',
      notified: false,
    });
  });

  it.each<[string, Script, readonly string[]]>([
    [
      'the first look at the schedule',
      { due: (id) => (id === 'alpha' ? fault() : dueAt()) },
      ['due'],
    ],
    [
      'the lock',
      { lock: (id) => (id === 'alpha' ? fault() : 'held') },
      ['due', 'lock'],
    ],
    [
      'the second look at the schedule',
      {
        due: (id, look) => (id === 'alpha' && look === 2 ? fault() : dueAt()),
      },
      ['due', 'lock', 'due', 'release'],
    ],
    [
      'the opening of the run',
      { open: (id) => (id === 'alpha' ? fault() : undefined) },
      ['due', 'lock', 'due', 'open', 'release'],
    ],
    [
      'the count of the try',
      {
        start: (id) => (id === 'alpha' ? fault() : { ok: true, attempt: 1 }),
      },
      ['due', 'lock', 'due', 'open', 'start', 'close-run', 'release'],
    ],
  ])(
    'ends a routine as internal when %s throws, frees it and goes on',
    async (_port, script, names) => {
      const h = setup(script);
      const pass = await runDue(
        [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
        h.ports,
        options(),
      );
      expect(pass.routines[0]).toEqual({
        routineId: 'alpha',
        status: 'internal',
        severity: 'internal',
      });
      expect(pass.routines[1]).toMatchObject({
        routineId: 'bravo',
        status: 'ran',
        severity: 'ok',
      });
      expect(pass.severity).toBe('internal');
      expect(h.order).toEqual([
        ...steps('alpha', ...names),
        ...steps('bravo', ...dueDraft),
      ]);
    },
  );

  it.each<[string, Script, Partial<RoutineReport>]>([
    [
      'the close of the trigger',
      { close: (id) => (id === 'alpha' ? fault() : true) },
      { closed: false, recorded: true, notified: true, severity: 'temporary' },
    ],
    [
      'the audit line',
      { end: (id) => (id === 'alpha' ? fault() : true) },
      { closed: true, recorded: false, notified: true, severity: 'temporary' },
    ],
    [
      'the notice',
      { notify: (id) => (id === 'alpha' ? fault() : true) },
      { closed: true, recorded: true, notified: false, severity: 'file' },
    ],
  ])(
    'keeps the other steps after a run that wrote when %s throws',
    async (_port, script, expected) => {
      const h = setup(script);
      const pass = await runDue(
        [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
        h.ports,
        options(),
      );
      expect(pass.routines[0]).toMatchObject({
        routineId: 'alpha',
        status: 'ran',
        outcome: { result: 'written' },
        ...expected,
      });
      // The run wrote: its audit line and its notice still come, and the
      // lock is free.
      expect(h.order).toEqual([
        ...steps('alpha', ...dueWiki),
        ...steps('bravo', ...dueDraft),
      ]);
    },
  );

  it.each<[string, Target, Script, readonly string[]]>([
    [
      'the kill switch',
      'wiki',
      { killSwitch: (id) => (id === 'alpha' ? fault() : 'on') },
      ['kill'],
    ],
    [
      'a read',
      'wiki',
      {
        read: (id) =>
          id === 'alpha'
            ? Promise.reject(new Error('A read failed.'))
            : Promise.resolve(emptyRead()),
      },
      ['kill', 'read'],
    ],
    [
      'the write',
      'wiki',
      { write: () => Promise.reject(new Error('A write failed.')) },
      ['kill', 'read', 'model', 'write'],
    ],
    [
      'the draft',
      'draft',
      {
        draft: (call) => (call.routineId === 'alpha' ? fault() : { ok: true }),
      },
      ['kill', 'read', 'model', 'draft'],
    ],
  ])(
    'ends a run as a final internal failure when %s throws inside it',
    async (_port, target, script, names) => {
      const h = setup(script);
      const pass = await runDue(
        [prepared('alpha', target), prepared('bravo', 'draft')],
        h.ports,
        options(),
      );
      const period = target === 'wiki' ? '2026-W46' : '2026-11-09';
      expect(pass.routines[0]).toEqual({
        routineId: 'alpha',
        status: 'ran',
        severity: 'internal',
        outcome: { result: 'failed', code: 'internal', final: true },
        runId: 'run-alpha',
        period,
        attempt: 1,
        recorded: true,
        closed: true,
        notified: true,
      });
      expect(pass.routines[1]).toMatchObject({ status: 'ran', severity: 'ok' });
      expect(h.order).toEqual([
        ...steps(
          'alpha',
          'due',
          'lock',
          'due',
          'open',
          'start',
          ...names,
          'close-trigger',
          'end',
          'notify',
          'close-run',
          'release',
        ),
        ...steps('bravo', ...dueDraft),
      ]);
      expect(h.lines[0]).toEqual({
        result: 'failed',
        code: 'internal',
        attempt: 1,
        period,
        durationMs: 0,
      });
    },
  );
});

describe('the deadline and the stop of a pass', () => {
  const notClosed = steps(
    'alpha',
    'due',
    'lock',
    'due',
    'open',
    'start',
    'kill',
    'read',
    'model',
    'end',
    'notify',
    'close-run',
    'release',
  );

  it('aborts the model after the longest run and writes nothing', async () => {
    const h = setup({
      provider: () => createMockModelProvider({ kind: 'slow' }).provider,
    });
    const pass = await runDue(
      [prepared('alpha', 'wiki')],
      h.ports,
      options({ maxRunMs: 5 }),
    );
    expect(pass.routines[0]).toMatchObject({
      status: 'ran',
      severity: 'temporary',
      outcome: {
        result: 'failed',
        step: 'model',
        code: 'network',
        final: false,
      },
    });
    expect(h.order).toEqual(notClosed);
    expect(h.writeCalls).toEqual([]);
  });

  it('aborts reading after the longest run and asks no model', async () => {
    const h = setup({
      read: (_id, signal) =>
        abortOf(signal).then((): RunCallOutcome => ({
          ok: false,
          code: 'network',
          transient: true,
        })),
    });
    const pass = await runDue(
      [prepared('alpha', 'wiki')],
      h.ports,
      options({ maxRunMs: 5 }),
    );
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      outcome: { step: 'input', code: 'network', final: false },
    });
    expect(h.order).not.toContain('model:alpha');
    expect(h.writeCalls).toEqual([]);
  });

  it('begins no write after the longest run, even when the answer came', async () => {
    const h = setup({ provider: lateProvider });
    const pass = await runDue(
      [prepared('alpha', 'wiki')],
      h.ports,
      options({ maxRunMs: 5 }),
    );
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      outcome: {
        result: 'failed',
        step: 'write',
        code: 'network',
        final: false,
      },
    });
    expect(h.order).toEqual(notClosed);
    expect(h.writeCalls).toEqual([]);
  });

  it('begins no write after a stop during reading, and no further routine', async () => {
    const controller = new AbortController();
    const h = setup({
      read: () => {
        controller.abort();
        return Promise.resolve(emptyRead());
      },
    });
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options({ signal: controller.signal }),
    );
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      outcome: { step: 'write', code: 'network', final: false },
    });
    expect(pass.routines[1]).toEqual({
      routineId: 'bravo',
      status: 'stopped',
      severity: 'ok',
    });
    expect(h.order).toEqual(notClosed);
    expect(h.writeCalls).toEqual([]);
  });

  it('never aborts a write that began, and begins no retry after the stop', async () => {
    const controller = new AbortController();
    const h = setup({
      write: (_id, count) => {
        // The stop arrives while the write runs.
        controller.abort();
        return Promise.resolve(
          count === 1
            ? { ok: false, code: 'conflict', sent: false, transient: true }
            : verified,
        );
      },
    });
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options({ signal: controller.signal }),
    );
    // The write that began was not aborted; a second one after the
    // conflict is a new write, and none begins after the stop (ADR 0034).
    expect(h.writeCalls.map((write) => write.signal.aborted)).toEqual([false]);
    expect(pass.routines[0]).toMatchObject({
      severity: 'temporary',
      outcome: {
        result: 'failed',
        step: 'write',
        code: 'conflict',
        final: false,
      },
    });
    expect(pass.routines[0]?.closed).toBeUndefined();
    expect(pass.routines[1]).toMatchObject({ status: 'stopped' });
    expect(h.order).toEqual(
      steps('alpha', ...dueWiki).filter(
        (name) => name !== 'close-trigger:alpha',
      ),
    );
  });

  it('tries a write once more after a conflict before the deadline', async () => {
    const h = setup({
      write: (_id, count) =>
        Promise.resolve(
          count === 1
            ? { ok: false, code: 'conflict', sent: false, transient: true }
            : verified,
        ),
    });
    const pass = await runDue([prepared('alpha', 'wiki')], h.ports, options());
    expect(h.writeCalls).toHaveLength(2);
    expect(pass.routines[0]).toMatchObject({
      severity: 'ok',
      outcome: { result: 'written', final: true },
      closed: true,
    });
  });

  it('calls nothing when the pass was stopped before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = setup();
    const pass = await runDue(
      [prepared('alpha', 'wiki'), prepared('bravo', 'draft')],
      h.ports,
      options({ signal: controller.signal }),
    );
    expect(pass).toEqual({
      routines: [
        { routineId: 'alpha', status: 'stopped', severity: 'ok' },
        { routineId: 'bravo', status: 'stopped', severity: 'ok' },
      ],
      severity: 'ok',
    });
    expect(h.order).toEqual([]);
  });
});

describe('a run by hand', () => {
  it('takes the last trigger, counts no try and closes the trigger on a final outcome', async () => {
    const h = setup({
      due: fault,
      start: fault,
      last: () => laterTrigger,
    });
    const done = await runByHand(prepared('alpha', 'wiki'), h.ports, options());
    expect(done).toEqual({
      routineId: 'alpha',
      status: 'ran',
      severity: 'ok',
      outcome: { result: 'written', final: true },
      runId: 'run-alpha',
      period: '2026-W47',
      recorded: true,
      closed: true,
      notified: true,
    });
    expect(Object.isFrozen(done)).toBe(true);
    expect(h.order).toEqual(
      steps(
        'alpha',
        'lock',
        'last',
        'open',
        'kill',
        'read',
        'model',
        'write',
        'close-trigger',
        'end',
        'notify',
        'close-run',
        'release',
      ),
    );
    expect(h.closes).toEqual([laterTrigger]);
    expect(h.lines).toEqual([
      { result: 'written', period: '2026-W47', durationMs: 0 },
    ]);
    expect(h.lines[0]).not.toHaveProperty('attempt');
  });

  it('leaves the trigger open after a failure a later try may pass', async () => {
    const h = setup({
      write: () =>
        Promise.resolve({
          ok: false,
          code: 'rate_limited',
          sent: false,
          transient: true,
        }),
    });
    const done = await runByHand(prepared('alpha', 'wiki'), h.ports, options());
    expect(done).toMatchObject({
      severity: 'temporary',
      outcome: { code: 'rate_limited', final: false },
    });
    expect(h.closes).toEqual([]);
  });

  it('is temporary when another process holds the lock, since the run did not happen', async () => {
    const h = setup({ lock: () => 'busy' });
    const done = await runByHand(prepared('alpha', 'wiki'), h.ports, options());
    expect(done).toEqual({
      routineId: 'alpha',
      status: 'busy',
      severity: 'temporary',
    });
    expect(h.order).toEqual(['lock:alpha']);
  });
});

describe('a preview', () => {
  it('reads and asks the model, and returns the section without writing, closing or noticing', async () => {
    const h = setup();
    const shown = await previewRoutine(
      prepared('alpha', 'wiki', true),
      h.ports,
      options(),
    );
    expect(shown).toEqual({
      routineId: 'alpha',
      status: 'ran',
      severity: 'ok',
      outcome: { result: 'preview', final: true },
      runId: 'run-alpha',
      period: '2026-W46',
      recorded: true,
      section: emptySection('2026-W46'),
    });
    expect(Object.isFrozen(shown)).toBe(true);
    // No lock, no kill switch, no try, no close, no notice, no write and
    // no draft.
    expect(h.order).toEqual(
      steps('alpha', 'last', 'open', 'read', 'model', 'end', 'close-run'),
    );
    expect(h.lines).toEqual([
      { result: 'preview', period: '2026-W46', durationMs: 0 },
    ]);
    expect(h.lines[0]).not.toHaveProperty('attempt');
  });

  it.each<[string, Script, string, Record<string, unknown>]>([
    [
      'a refused sign-in of the model',
      {
        provider: () =>
          createMockModelProvider({ kind: 'failing', code: 'auth' }).provider,
      },
      'refused',
      { step: 'model', code: 'auth', final: true },
    ],
    [
      'a read a later try may pass',
      {
        read: () =>
          Promise.resolve({ ok: false, code: 'network', transient: true }),
      },
      'temporary',
      { step: 'input', code: 'network', final: false },
    ],
    [
      'a breach of the content policy',
      {
        provider: () =>
          answering({ liste: [{ text: 'siehe gemeinde.example' }] }),
      },
      'data',
      {
        step: 'answer',
        code: 'run_content_refused',
        final: true,
        violations: ['webAddress'],
      },
    ],
    [
      'a read that throws',
      { read: () => Promise.reject(new Error('A read failed.')) },
      'internal',
      { code: 'internal', final: true },
    ],
  ])(
    'ends with the severity of %s',
    async (_case, script, severity, outcome) => {
      const h = setup(script);
      const shown = await previewRoutine(
        prepared('alpha', 'wiki', true),
        h.ports,
        options(),
      );
      expect(shown).toMatchObject({
        status: 'ran',
        severity,
        outcome: { result: 'failed', ...outcome },
        recorded: true,
      });
      expect(shown).not.toHaveProperty('section');
      expect(h.order).toContain('end:alpha');
      expect(h.order.at(-1)).toBe('close-run:alpha');
    },
  );

  it('ends as not opened when the run cannot be opened', async () => {
    const h = setup({ open: () => ({ ok: false, code: 'model_refused' }) });
    const shown = await previewRoutine(
      prepared('alpha', 'wiki', true),
      h.ports,
      options(),
    );
    expect(shown).toEqual({
      routineId: 'alpha',
      status: 'not_opened',
      severity: 'config',
      code: 'model_refused',
      period: '2026-W46',
    });
    expect(h.order).toEqual(steps('alpha', 'last', 'open'));
  });

  it('ends as temporary when the audit file did not take its line', async () => {
    const h = setup({ end: () => false });
    const shown = await previewRoutine(
      prepared('alpha', 'wiki', true),
      h.ports,
      options(),
    );
    expect(shown).toMatchObject({
      severity: 'temporary',
      recorded: false,
      outcome: { result: 'preview' },
    });
  });

  it('ends as internal when a port throws, and closes an opened run', async () => {
    const before = setup({ last: fault });
    expect(
      await previewRoutine(
        prepared('alpha', 'wiki', true),
        before.ports,
        options(),
      ),
    ).toEqual({ routineId: 'alpha', status: 'internal', severity: 'internal' });
    expect(before.order).toEqual(['last:alpha']);
    const after = setup({ end: fault });
    expect(
      await previewRoutine(
        prepared('alpha', 'wiki', true),
        after.ports,
        options(),
      ),
    ).toEqual({ routineId: 'alpha', status: 'internal', severity: 'internal' });
    expect(after.order.at(-1)).toBe('close-run:alpha');
  });
});
