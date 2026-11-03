import type {
  NonceStore,
  PlannedWrite,
  PlanStore,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createTestClock } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  type ConfirmationAnswer,
  confirmationSentence,
  confirmationSentences,
  confirmationWayOf,
  createConfirmations,
} from './confirm.js';
import { confirmationTextOf } from './confirmation-text.js';
import { createMemoryNonceStore } from './nonce-store.js';
import { contentHashOf } from './plan-hash.js';
import { createMemoryPlanStore, planTtlMs } from './plan-store.js';
import { useProof } from './proof.js';
import {
  argumentsDigestOf,
  principalDigestOf,
  readConfirmationState,
} from './request-state.js';
import { type PlanInput, readPlan, sealPlan } from './sealed-plan.js';

const start = Date.UTC(2026, 10, 3, 12, 0, 0);
const guid = '00000000-0000-4000-8000-000000000001';

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly code?: unknown;
}

const contextOf = (
  logged: Logged[],
  id = 'stdio:local-stdio',
): TenantContext => {
  const log =
    (level: string) => (event: string, fields?: { code?: unknown }) => {
      logged.push({
        level,
        event,
        ...(fields?.code === undefined ? {} : { code: fields.code }),
      });
    };
  return {
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id },
    log: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
  } as unknown as TenantContext;
};

const sealed = (change: Partial<PlanInput> = {}): PlannedWrite =>
  sealPlan({
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    tool: 'ct_example_note_write',
    origin: 'core',
    intent: {
      kind: 'wikiSectionAppend',
      categoryId: 12,
      guid,
      section: '## Nachtrag',
      baseVersion: 3,
    },
    toolMeta: { sensitivity: 'personal', unattended: 'policy' },
    contentHash: contentHashOf(['# Plan\n\n## Nachtrag\n']),
    sealedAt: start,
    snapshots: true,
    ...change,
  });

const text = confirmationTextOf({
  kind: 'wikiSectionAppend',
  categoryId: 12,
  title: 'Plan',
  before: '# Plan\n',
  after: '# Plan\n\n## Nachtrag\n',
});

const input = Object.freeze({ section: '## Nachtrag' });

// Sixteen bytes that count up, so that every nonce differs.
const counting = (): ((size: number) => Uint8Array) => {
  let next = 0;
  return (size) => {
    next += 1;
    return Uint8Array.from({ length: size }, () => next);
  };
};

const setup = (
  change: Partial<{ plans: PlanStore; nonces: NonceStore }> = {},
): {
  readonly clock: ReturnType<typeof createTestClock>;
  readonly confirmations: ReturnType<typeof createConfirmations>;
} => {
  const clock = createTestClock(start);
  return {
    clock,
    confirmations: createConfirmations({
      plans: change.plans ?? createMemoryPlanStore(clock),
      nonces: change.nonces ?? createMemoryNonceStore(clock),
      clock,
      random: counting(),
    }),
  };
};

const yes = (state: unknown): ConfirmationAnswer => ({
  state,
  action: 'accept',
  content: { bestaetigen: true },
});

describe('the way of a confirmation', () => {
  const echoPlan = sealed();
  const plainPlan = sealed({ snapshots: false });

  it('asks the client first, when it can and the diff fits', () => {
    for (const setting of ['echo-allowed', 'elicitation-or-queue'] as const) {
      expect(
        confirmationWayOf({ setting, elicitation: true, fits: true }, echoPlan),
      ).toBe('question');
    }
  });

  it('sends a diff too long for a question to the queue, not to the echo', () => {
    expect(
      confirmationWayOf(
        { setting: 'echo-allowed', elicitation: true, fits: false },
        echoPlan,
      ),
    ).toBe('queue');
  });

  it('takes the echo without elicitation only where setting and plan allow it', () => {
    const way = (
      setting: 'echo-allowed' | 'elicitation-or-queue',
      plan: PlannedWrite,
    ) => confirmationWayOf({ setting, elicitation: false, fits: true }, plan);
    expect(way('echo-allowed', echoPlan)).toBe('echo');
    // Counter-checks: the setting without the echo, a plan without it.
    expect(way('elicitation-or-queue', echoPlan)).toBe('queue');
    expect(way('echo-allowed', plainPlan)).toBe('queue');
    expect(way('echo-allowed', sealed({ origin: 'plugin' }))).toBe('queue');
  });

  it('sends every plan to the queue with the setting queue', () => {
    for (const elicitation of [true, false]) {
      expect(
        confirmationWayOf(
          { setting: 'queue', elicitation, fits: true },
          echoPlan,
        ),
      ).toBe('queue');
    }
  });

  it('refuses a value that is no sealed plan', () => {
    expect(() =>
      confirmationWayOf(
        { setting: 'echo-allowed', elicitation: true, fits: true },
        { __ecclium: 'PlannedWrite' } as unknown as PlannedWrite,
      ),
    ).toThrow(TypeError);
  });
});

describe('a question before a write', () => {
  it('keeps the plan and asks with a state that names plan, tool, principal and input', async () => {
    const logged: Logged[] = [];
    const ctx = contextOf(logged);
    const { confirmations } = setup();
    const plan = sealed();
    const asked = await confirmations.ask(ctx, plan, input, text);
    if (asked.kind !== 'question') throw new Error('no question');
    const { question } = asked;
    expect(question.message).toContain(text.summary);
    expect(question.form.required).toEqual(['bestaetigen']);
    expect(question.state).toEqual({
      v: 1,
      tool: 'ct_example_note_write',
      planHash: readPlan(plan)?.planHash,
      nonce: '01'.repeat(16),
      principal: principalDigestOf('demo-tenant', ctx.actor),
      arguments: argumentsDigestOf(input),
    });
    expect(readConfirmationState(question.state)).toEqual(question.state);
    expect(Object.isFrozen(question)).toBe(true);
    expect(logged).toEqual([]);
  });

  it('refuses a question when too many plans wait, and says so in the log', async () => {
    const logged: Logged[] = [];
    const clock = createTestClock(start);
    const { confirmations } = setup({
      plans: createMemoryPlanStore(clock, 1),
    });
    const ctx = contextOf(logged);
    expect((await confirmations.ask(ctx, sealed(), input, text)).kind).toBe(
      'question',
    );
    const second = await confirmations.ask(
      ctx,
      sealed({ contentHash: contentHashOf(['other']) }),
      input,
      text,
    );
    expect(second).toEqual({
      kind: 'refused',
      error: expect.objectContaining({
        code: 'policy_denied',
        message: confirmationSentences.tooMany,
      }) as unknown,
    });
    expect(logged).toEqual([
      { level: 'warn', event: 'write_plans_full', code: 'policy_denied' },
    ]);
  });

  it('refuses a value that is no sealed plan', async () => {
    const { confirmations } = setup();
    await expect(
      confirmations.ask(
        contextOf([]),
        {} as unknown as PlannedWrite,
        input,
        text,
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe('the answer to a question', () => {
  const asked = async (
    confirmations: ReturnType<typeof createConfirmations>,
    ctx: TenantContext,
    plan: PlannedWrite = sealed(),
  ): Promise<unknown> => {
    const result = await confirmations.ask(ctx, plan, input, text);
    if (result.kind !== 'question') throw new Error('no question');
    return result.question.state;
  };

  it('gives the plan of the question with a proof of the elicitation for a yes', async () => {
    const logged: Logged[] = [];
    const ctx = contextOf(logged);
    const { clock, confirmations } = setup();
    const plan = sealed();
    const state = await asked(confirmations, ctx, plan);
    const answered = await confirmations.answer(
      ctx,
      'ct_example_note_write',
      { ...input },
      yes(state),
    );
    if (answered.kind !== 'confirmed') throw new Error('not confirmed');
    expect(answered.plan).toBe(plan);
    const view = readPlan(plan);
    if (view === undefined) throw new Error('no plan');
    expect(useProof(answered.proof, view, clock.now())).toBe('elicitation');
    expect(logged).toEqual([]);
  });

  it.each([
    ['a decline', { action: 'decline' }],
    ['a cancel', { action: 'cancel' }],
    ['no answer', { action: 'missing' }],
    ['a no', { action: 'accept', content: { bestaetigen: false } }],
    ['an accept without content', { action: 'accept' }],
    [
      'an accept with a field more',
      { action: 'accept', content: { bestaetigen: true, x: 1 } },
    ],
  ] as const)(
    'writes nothing after %s, and the plan is gone',
    async (_name, given) => {
      const logged: Logged[] = [];
      const ctx = contextOf(logged);
      const { confirmations } = setup();
      const state = await asked(confirmations, ctx);
      const answer = { state, ...given } as ConfirmationAnswer;
      expect(
        await confirmations.answer(ctx, 'ct_example_note_write', input, answer),
      ).toEqual({
        kind: 'refused',
        error: expect.objectContaining({
          code: 'confirmation_required',
          message: confirmationSentences.notConfirmed,
        }) as unknown,
      });
      expect(logged).toEqual([
        {
          level: 'info',
          event: 'write_not_confirmed',
          code: 'confirmation_required',
        },
      ]);
      // A yes after the no finds its nonce used.
      expect(
        (
          await confirmations.answer(
            ctx,
            'ct_example_note_write',
            input,
            yes(state),
          )
        ).kind,
      ).toBe('refused');
    },
  );

  it('counts an answer only once', async () => {
    const logged: Logged[] = [];
    const ctx = contextOf(logged);
    const { confirmations } = setup();
    const state = await asked(confirmations, ctx);
    const first = await confirmations.answer(
      ctx,
      'ct_example_note_write',
      input,
      yes(state),
    );
    expect(first.kind).toBe('confirmed');
    const again = await confirmations.answer(
      ctx,
      'ct_example_note_write',
      input,
      yes(state),
    );
    expect(again).toEqual({
      kind: 'refused',
      error: expect.objectContaining({
        code: 'confirmation_required',
        message: confirmationSentences.used,
      }) as unknown,
    });
    expect(logged.at(-1)).toEqual({
      level: 'warn',
      event: 'write_answer_replayed',
      code: 'confirmation_required',
    });
  });

  it.each([
    ['another tool', { tool: 'ct_other_write' }],
    ['another input', { input: { section: '## Anders' } }],
    ['another actor', { id: 'stdio:other' }],
  ])(
    'refuses an answer for %s, before it uses up the nonce',
    async (_name, change) => {
      const logged: Logged[] = [];
      const ctx = contextOf(logged);
      const { confirmations } = setup();
      const state = await asked(confirmations, ctx);
      const other = 'id' in change ? contextOf(logged, change.id) : ctx;
      const refused = await confirmations.answer(
        other,
        'tool' in change ? change.tool : 'ct_example_note_write',
        'input' in change ? change.input : input,
        yes(state),
      );
      expect(refused).toEqual({
        kind: 'refused',
        error: expect.objectContaining({
          code: 'confirmation_required',
          message: confirmationSentences.notThisCall,
        }) as unknown,
      });
      expect(logged).toEqual([
        {
          level: 'warn',
          event: 'write_answer_refused',
          code: 'confirmation_required',
        },
      ]);
      // The right call still finds its plan.
      expect(
        (
          await confirmations.answer(
            ctx,
            'ct_example_note_write',
            input,
            yes(state),
          )
        ).kind,
      ).toBe('confirmed');
    },
  );

  it.each([null, {}, 'state', { v: 2 }])(
    'refuses a state of another form: %j',
    async (state) => {
      const { confirmations } = setup();
      const result = await confirmations.answer(
        contextOf([]),
        'ct_example_note_write',
        input,
        yes(state),
      );
      expect(result.kind).toBe('refused');
    },
  );

  it('writes nothing when the plan expired, as after a restart', async () => {
    const logged: Logged[] = [];
    const ctx = contextOf(logged);
    const { clock, confirmations } = setup();
    const state = await asked(confirmations, ctx);
    clock.advance(planTtlMs);
    expect(
      await confirmations.answer(
        ctx,
        'ct_example_note_write',
        input,
        yes(state),
      ),
    ).toEqual({
      kind: 'refused',
      error: expect.objectContaining({
        code: 'confirmation_required',
        message: confirmationSentences.gone,
      }) as unknown,
    });
    expect(logged).toEqual([
      {
        level: 'warn',
        event: 'write_plan_gone',
        code: 'confirmation_required',
      },
    ]);
  });

  it('takes a store that rejects as one that says no', async () => {
    const clock = createTestClock(start);
    const plans = createMemoryPlanStore(clock);
    const nonces = createMemoryNonceStore(clock);
    const rejects = () => Promise.reject(new Error('store'));
    const ctx = contextOf([]);
    const nonceFails = createConfirmations({
      plans,
      nonces: { consume: rejects },
      clock,
      random: counting(),
    });
    const first = await nonceFails.ask(ctx, sealed(), input, text);
    if (first.kind !== 'question') throw new Error('no question');
    expect(
      await nonceFails.answer(
        ctx,
        'ct_example_note_write',
        input,
        yes(first.question.state),
      ),
    ).toMatchObject({
      kind: 'refused',
      error: { message: confirmationSentences.used },
    });
    const planFails = createConfirmations({
      plans: {
        put: (...args: Parameters<PlanStore['put']>) => plans.put(...args),
        take: rejects,
      },
      nonces,
      clock,
      random: counting(),
    });
    const second = await planFails.ask(
      ctx,
      sealed({ contentHash: contentHashOf(['two']) }),
      input,
      text,
    );
    if (second.kind !== 'question') throw new Error('no question');
    expect(
      await planFails.answer(
        ctx,
        'ct_example_note_write',
        input,
        yes(second.question.state),
      ),
    ).toMatchObject({
      kind: 'refused',
      error: { message: confirmationSentences.gone },
    });
  });

  it('keeps the sentence of a way that is not built yet', () => {
    expect(confirmationSentence).toBe(
      'The write needs a confirmation, which this server cannot ask for yet, so nothing was written.',
    );
  });
});
