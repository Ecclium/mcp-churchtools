import type {
  Policy,
  RunWriteOutcome,
  UnattendedEntry,
} from '@ecclium/mcp-churchtools-core';
import type { Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import type { Routine } from '../routine/schema.js';
import { accountToolsOf } from './account.js';
import { type PreparedRun, runCredentialOf } from './prepare.js';
import {
  type RenderedRun,
  type RunWriteCall,
  type RunWriteResult,
  writeRun,
} from './write.js';

// The write of a run on a stand-in of the port (ADR 0032, ADR 0033). The
// core behind the port is covered in its own tests, the whole way from the
// read to the page in the tests of the composition root.

const guid = '0000000a-0000-4000-8000-000000000001';

const entryOf = (target: UnattendedEntry['target']): UnattendedEntry => ({
  routine: 'bericht',
  credential: 'berichte',
  modelRedaction: 'strict',
  target,
  tools: ['ct_wiki_page_append_section'],
  maxPerRun: 1,
  maxPerDay: 2,
});

const rendered = (
  target: UnattendedEntry['target'] = {
    kind: 'wiki_category',
    id: 7,
    name: 'Berichte',
  },
): RenderedRun => ({
  kind: 'rendered',
  routineId: 'bericht',
  period: '2026-W46',
  section: '## Bericht 2026-W46\n\nNichts.',
  output: {
    target: 'wiki',
    tool: 'ct_wiki_page_append_section',
    scope: { category: 'Berichte', page: 'Auswertung' },
    idempotencyKey: 'bericht:{isoWeek}',
    period: 'isoWeek',
  },
  target: entryOf(target),
  credential: 'berichte',
  provider: {
    vendor: 'example',
    model: 'example-1',
    hostingCountry: 'CH',
    endpointHost: 'model.example.org',
  },
  attempts: 1,
  calls: 2,
});

const pageTarget = { kind: 'wiki_page' as const, key: `7/${guid}` };

const verified: RunWriteOutcome = {
  ok: true,
  state: 'verified',
  target: pageTarget,
  version: 4,
  undoId: '00000000-0000-4000-8000-0000000000aa',
};

const failure = (
  code: 'conflict' | 'not_found' | 'policy_denied' | 'network',
  more: { sent?: boolean; transient?: boolean; page?: 'ambiguous' } = {},
): RunWriteOutcome => ({
  ok: false,
  code,
  sent: more.sent ?? false,
  transient: more.transient ?? false,
  ...(more.page === undefined ? {} : { page: more.page }),
});

// A port that answers in turn and keeps every call, and a logger that
// keeps every event.
const setup = (...answers: readonly RunWriteOutcome[]) => {
  const calls: RunWriteCall[] = [];
  const events: string[] = [];
  let next = 0;
  const log: Logger = {
    debug: (event) => events.push(event),
    info: (event) => events.push(event),
    warn: (event) => events.push(event),
    error: (event) => events.push(event),
  };
  const ports = {
    write: (call: RunWriteCall): Promise<RunWriteOutcome> => {
      calls.push(call);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      return Promise.resolve(answer as RunWriteOutcome);
    },
    log,
    clock: { now: () => Date.UTC(2026, 10, 9, 5) },
  };
  return { calls, events, ports };
};

const signal = new AbortController().signal;

describe('the write of a run', () => {
  it('names a category with the name of the page of the routine, and nothing more', async () => {
    const { calls, events, ports } = setup(verified);
    const result = await writeRun(rendered(), ports, signal);
    expect(calls).toEqual([
      {
        tool: 'ct_wiki_page_append_section',
        period: '2026-W46',
        section: '## Bericht 2026-W46\n\nNichts.',
        page: { categoryId: 7, title: 'Auswertung' },
      },
    ]);
    expect(result).toEqual({
      kind: 'written',
      target: pageTarget,
      version: 4,
      undoId: '00000000-0000-4000-8000-0000000000aa',
      attempts: 1,
    });
    expect(events).toEqual(['run_written']);
  });

  it('names a page by its GUID, as the policy does', async () => {
    const { calls, ports } = setup(verified);
    await writeRun(
      rendered({ kind: 'wiki_page', categoryId: 7, guid, name: 'Auswertung' }),
      ports,
      signal,
    );
    expect(calls[0]?.page).toEqual({ categoryId: 7, guid });
  });

  it.each<[RunWriteOutcome, RunWriteResult, string]>([
    [
      { ok: true, state: 'skipped', target: pageTarget },
      { kind: 'skipped', target: pageTarget },
      'run_write_skipped',
    ],
    [
      { ok: true, state: 'queued', target: pageTarget, queueId: 'q-1' },
      { kind: 'queued', target: pageTarget, queueId: 'q-1' },
      'run_write_queued',
    ],
  ])('passes on %j', async (outcome, expected, event) => {
    const { calls, events, ports } = setup(outcome);
    expect(await writeRun(rendered(), ports, signal)).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([event]);
  });

  it('tries a conflict before the send once more, with the same call', async () => {
    const { calls, events, ports } = setup(failure('conflict'), verified);
    const result = await writeRun(rendered(), ports, signal);
    expect(result).toMatchObject({ kind: 'written', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(events).toEqual(['run_write_retried', 'run_written']);
  });

  it('tries only once more, and leaves a second conflict to a later run', async () => {
    const { calls, events, ports } = setup(
      failure('conflict', { transient: true }),
      failure('conflict', { transient: true }),
      verified,
    );
    expect(await writeRun(rendered(), ports, signal)).toEqual({
      kind: 'failed',
      code: 'conflict',
      final: false,
      sent: false,
    });
    expect(calls).toHaveLength(2);
    expect(events).toEqual(['run_write_retried', 'run_write_failed']);
  });

  it.each<[string, RunWriteOutcome]>([
    ['a conflict after the send', failure('conflict', { sent: true })],
    [
      'a page twice in its category',
      failure('conflict', { page: 'ambiguous' }),
    ],
  ])('never tries %s again', async (_name, outcome) => {
    const { calls, ports } = setup(outcome, verified);
    expect((await writeRun(rendered(), ports, signal)).kind).toBe('failed');
    expect(calls).toHaveLength(1);
  });

  it('tries nothing again once the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, ports } = setup(failure('conflict'), verified);
    expect((await writeRun(rendered(), ports, controller.signal)).kind).toBe(
      'failed',
    );
    expect(calls).toHaveLength(1);
  });

  it.each<[RunWriteOutcome, RunWriteResult]>([
    [
      failure('not_found'),
      { kind: 'failed', code: 'not_found', final: true, sent: false },
    ],
    [
      failure('network', { sent: true, transient: true }),
      { kind: 'failed', code: 'network', final: false, sent: true },
    ],
    [
      failure('policy_denied'),
      { kind: 'failed', code: 'policy_denied', final: true, sent: false },
    ],
    [
      failure('conflict', { page: 'ambiguous' }),
      {
        kind: 'failed',
        code: 'conflict',
        final: true,
        sent: false,
        page: 'ambiguous',
      },
    ],
  ])('ends %j with whether a later run may pass', async (outcome, expected) => {
    const { events, ports } = setup(outcome);
    expect(await writeRun(rendered(), ports, signal)).toEqual(expected);
    expect(events).toEqual(['run_write_failed']);
  });

  it('writes no draft and no run without the entry of its target', async () => {
    const { calls, ports } = setup(verified);
    const draft: RenderedRun = {
      ...rendered(),
      output: {
        target: 'draft',
        channel: 'file',
        idempotencyKey: 'bericht:{date}',
        period: 'date',
      },
    };
    const untargeted: RenderedRun = { ...rendered() };
    delete (untargeted as { target?: unknown }).target;
    await expect(writeRun(draft, ports, signal)).rejects.toThrow(TypeError);
    await expect(writeRun(untargeted, ports, signal)).rejects.toThrow(
      TypeError,
    );
    await expect(
      writeRun(
        rendered({ kind: 'calendar', id: 3, name: 'Gottesdienste' }),
        ports,
        signal,
      ),
    ).rejects.toThrow(TypeError);
    // A routine prepared for a preview writes nothing, even with an entry.
    await expect(
      writeRun({ ...rendered(), preview: true }, ports, signal),
    ).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });
});

describe('the tools of an account', () => {
  // A prepared routine as the preparation gives it: the facts of each
  // input and the alias of its account.
  const preparedOf = (
    id: string,
    tools: readonly string[],
    wiki: boolean,
    credential?: string,
  ): PreparedRun =>
    ({
      loaded: {
        routine: {
          id,
          output: wiki
            ? {
                target: 'wiki',
                tool: 'ct_wiki_page_append_section',
                scope: { category: 'Berichte', page: 'Auswertung' },
                idempotencyKey: 'x:{date}',
                period: 'date',
              }
            : {
                target: 'draft',
                channel: 'file',
                idempotencyKey: 'x:{date}',
                period: 'date',
              },
        } as unknown as Routine,
      },
      inputs: tools.map((tool, index) => ({
        input: { name: `in${String(index)}`, tool, params: {}, maxItems: 5 },
      })),
      ...(credential === undefined ? {} : { credential }),
    }) as unknown as PreparedRun;

  const runs = [
    preparedOf(
      'bericht',
      ['ct_events_list', 'ct_services_get_assignments'],
      true,
      'berichte',
    ),
    preparedOf(
      'hygiene',
      ['ct_wiki_pages_list', 'ct_events_list'],
      true,
      'berichte',
    ),
    preparedOf('vorschau', ['ct_appointments_list'], false, 'andere'),
    preparedOf('ohne-eintrag', ['ct_songs_search'], false),
  ];

  it('are the tools of every prepared routine with the alias, each once', () => {
    expect(accountToolsOf(runs, 'berichte')).toEqual([
      'ct_events_list',
      'ct_services_get_assignments',
      'ct_wiki_page_append_section',
      'ct_wiki_pages_list',
    ]);
  });

  it('leave out the routines of another alias and those without an entry', () => {
    expect(accountToolsOf(runs, 'andere')).toEqual(['ct_appointments_list']);
    expect(accountToolsOf(runs, 'keines')).toEqual([]);
  });

  it('count the routines without an entry for the own account of the runner', () => {
    // A routine without an entry reads with the account `runner`, and a
    // routine whose entries name `runner` shares it (ADR 0023, ADR 0033).
    expect(accountToolsOf(runs, 'runner')).toEqual(['ct_songs_search']);
    expect(
      accountToolsOf(
        [...runs, preparedOf('eigen', ['ct_events_list'], true, 'runner')],
        'runner',
      ),
    ).toEqual([
      'ct_events_list',
      'ct_songs_search',
      'ct_wiki_page_append_section',
    ]);
  });
});

describe('the account of a routine', () => {
  const policy = {
    unattended: [
      { routine: 'bericht', credential: 'berichte' },
      { routine: 'bericht', credential: 'berichte' },
      { routine: 'gemischt', credential: 'berichte' },
      { routine: 'gemischt', credential: 'andere' },
    ],
  } as unknown as Policy;

  it('is the alias of the entries of the routine in the policy', () => {
    expect(runCredentialOf(policy, 'bericht')).toEqual({
      ok: true,
      credential: 'berichte',
    });
  });

  it('is none for a routine without an entry', () => {
    expect(runCredentialOf(policy, 'vorschau')).toEqual({ ok: true });
  });

  it('is not settled when the entries of the routine name two aliases', () => {
    expect(runCredentialOf(policy, 'gemischt')).toEqual({ ok: false });
  });
});
