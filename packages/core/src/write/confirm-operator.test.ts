import type {
  PlannedWrite,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { createTestClock } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it, vi } from 'vitest';

import {
  confirmationRouteOf,
  confirmationWayOf,
  createConfirmations,
} from './confirm.js';
import { confirmationTextOf } from './confirmation-text.js';
import { createMemoryNonceStore } from './nonce-store.js';
import { createMemoryPlanStore } from './plan-store.js';
import type { PlanView } from './sealed-plan.js';

// No intent that only the operator may confirm runs in this version of the
// core, so no such plan can be sealed. The view of the plan stands in for
// one, as a later version could seal it (ADR 0029).
const { plan, view } = vi.hoisted(() => ({
  plan: { __ecclium: 'PlannedWrite' } as unknown as PlannedWrite,
  view: {
    tenantId: 'demo-tenant',
    actor: { kind: 'service', id: 'stdio:local-stdio' },
    tool: 'ct_example_operation_write',
    origin: 'plugin',
    rules: { alwaysQueue: true, runs: true },
    planHash: 'e'.repeat(64),
    echo: false,
  } as unknown as PlanView,
}));

vi.mock('./sealed-plan.js', () => ({
  readPlan: (value: unknown) => (value === plan ? view : undefined),
}));

const ctx = {
  tenantId: 'demo-tenant',
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
} as unknown as TenantContext;

describe('a plan that only the operator may confirm', () => {
  it('goes to the queue whatever the client can, as one only the operator may confirm', () => {
    for (const setting of [
      'echo-allowed',
      'elicitation-or-queue',
      'queue',
    ] as const) {
      expect(
        confirmationWayOf({ setting, elicitation: true, fits: true }, plan),
      ).toBe('queue');
      expect(
        confirmationRouteOf({ setting, elicitation: true, fits: false }, plan),
      ).toEqual({ way: 'queue', reason: 'queue_only' });
    }
  });

  it('gets no proof from a yes of the client, should it ever be asked', async () => {
    const clock = createTestClock(Date.UTC(2026, 10, 3, 12));
    const confirmations = createConfirmations({
      plans: createMemoryPlanStore(clock),
      nonces: createMemoryNonceStore(clock),
      clock,
      random: (size) => new Uint8Array(size).fill(7),
    });
    const text = confirmationTextOf({
      kind: 'wikiSectionAppend',
      categoryId: 1,
      title: 'x',
      before: '',
      after: 'x\n',
    });
    const asked = await confirmations.ask(ctx, plan, {}, text);
    if (asked.kind !== 'question') throw new Error('no question');
    const answered = await confirmations.answer(
      ctx,
      'ct_example_operation_write',
      {},
      {
        state: asked.question.state,
        action: 'accept',
        content: { bestaetigen: true },
      },
    );
    expect(answered).toMatchObject({
      kind: 'refused',
      error: { code: 'confirmation_required' },
    });
  });
});
