import type {
  ConfirmationPath,
  PlannedWrite,
  WriteIntent,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { contentHashOf, planHashOf } from './plan-hash.js';
import { isProof, issueProof, useProof } from './proof.js';
import { rulesOf, withToolMeta } from './rules.js';
import {
  isSealedPlan,
  type PlanInput,
  type PlanView,
  readPlan,
  sealPlan,
} from './sealed-plan.js';

const guid = '00000000-0000-4000-8000-000000000001';
const update: WriteIntent = Object.freeze({
  kind: 'wikiPageUpdate',
  categoryId: 12,
  guid,
  text: '# Plan',
  baseVersion: 3,
});
const groupAdd: WriteIntent = Object.freeze({
  kind: 'groupMemberAdd',
  groupId: 7,
  personId: 1,
});

const inputOf = (
  intent: WriteIntent,
  change: Partial<PlanInput> = {},
): PlanInput => ({
  tenantId: 'demo-tenant',
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  tool: 'ct_wiki_page_update',
  origin: 'core',
  intent,
  rules: rulesOf(intent),
  baseVersion: 3,
  contentHash: contentHashOf(['# Plan']),
  sealedAt: 1_000,
  ...change,
});

const sealed = (change: Partial<PlanInput> = {}): PlannedWrite =>
  sealPlan(inputOf(update, change));

const viewOf = (plan: PlannedWrite): PlanView => {
  const view = readPlan(plan);
  if (view === undefined) throw new Error('no plan');
  return view;
};

// What code outside the core could try with a plan or a proof it holds.
const lookalikes = (value: object): unknown[] => [
  {},
  { __ecclium: 'PlannedWrite' },
  { __ecclium: 'WriteProof' },
  Object.create(value) as object,
  new Proxy(value, {}),
  { ...value },
  JSON.parse(JSON.stringify(value)) as unknown,
  null,
  undefined,
  'plan',
];

describe('a sealed plan', () => {
  it('computes its hash and the echo from what it is sealed from', () => {
    const input = inputOf(update);
    const view = viewOf(sealPlan(input));
    expect(view.planHash).toBe(
      planHashOf({
        tenantId: input.tenantId,
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        tool: input.tool,
        intentKind: 'wikiPageUpdate',
        targetKind: 'wiki_page',
        targetKey: `12/${guid}`,
        baseVersion: 3,
        contentHash: input.contentHash,
      }),
    );
    expect(view.echo).toBe(true);
    expect(view.intent).toBe(update);
    expect(Object.isFrozen(view)).toBe(true);
    // The actor is a copy of its own, frozen.
    expect(view.actor).toEqual(input.actor);
    expect(view.actor).not.toBe(input.actor);
    expect(Object.isFrozen(view.actor)).toBe(true);
  });

  it('allows the echo for no tool of a plugin', () => {
    expect(viewOf(sealed({ origin: 'plugin' })).echo).toBe(false);
  });

  it('shows nothing of itself to code that holds it', () => {
    const plan = sealed();
    expect(Object.keys(plan)).toEqual([]);
    expect(Object.getOwnPropertyNames(plan)).toEqual([]);
    expect(Object.getOwnPropertySymbols(plan)).toEqual([]);
    expect(JSON.stringify(plan)).toBe('{}');
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('is told apart from every lookalike, a proxy and a copy included', () => {
    const plan = sealed();
    expect(isSealedPlan(plan)).toBe(true);
    for (const value of lookalikes(plan)) {
      expect(isSealedPlan(value)).toBe(false);
      expect(readPlan(value)).toBeUndefined();
    }
  });

  it('can be neither made nor read through its class', () => {
    const plan = sealed();
    const Class = (plan as object).constructor as unknown as {
      new (key: symbol, view: unknown): object;
      read(key: symbol, value: unknown): unknown;
    };
    expect(
      () => new Class(Symbol('ecclium.sealed-plan'), viewOf(plan)),
    ).toThrow(TypeError);
    expect(Class.read(Symbol('ecclium.sealed-plan'), plan)).toBeUndefined();
    expect(() => {
      (Class as { read: unknown }).read = () => viewOf(plan);
    }).toThrow(TypeError);
    expect(Object.isFrozen(Class)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(plan))).toBe(true);
  });

  it('is not sealed from a base version that is no whole number', () => {
    expect(() => sealed({ baseVersion: -1 })).toThrow(TypeError);
  });
});

describe('a proof', () => {
  it.each<ConfirmationPath>(['elicitation', 'operator', 'echo', 'policy'])(
    'confirms its plan once on the way %s',
    (path) => {
      const plan = sealed();
      const proof = issueProof(plan, path, 2_000);
      expect(isProof(proof)).toBe(true);
      expect(useProof(proof, viewOf(plan))).toBe(path);
      expect(useProof(proof, viewOf(plan))).toBeUndefined();
      // A used proof is still a proof, but it confirms nothing.
      expect(isProof(proof)).toBe(true);
    },
  );

  it('confirms no other plan, and a proof tried on one is used up', () => {
    const plan = sealed();
    const other = sealed({ contentHash: contentHashOf(['# Anders']) });
    const proof = issueProof(plan, 'elicitation', 2_000);
    expect(useProof(proof, viewOf(other))).toBeUndefined();
    expect(useProof(proof, viewOf(plan))).toBeUndefined();
  });

  it.each([
    ['tenant', { tenantId: 'other-tenant' }],
    ['kind of actor', { actor: { kind: 'user', id: 'stdio:local-stdio' } }],
    ['ID of actor', { actor: { kind: 'service', id: 'stdio:other' } }],
  ] as const)(
    'confirms no plan of another %s, even with the same hash',
    (_name, change) => {
      const plan = sealed();
      const proof = issueProof(plan, 'elicitation', 2_000);
      expect(useProof(proof, { ...viewOf(plan), ...change })).toBeUndefined();
    },
  );

  it('is not issued for the echo where the plan does not allow it', () => {
    expect(() =>
      issueProof(sealed({ origin: 'plugin' }), 'echo', 2_000),
    ).toThrow(TypeError);
    const special = sealed({
      rules: withToolMeta(rulesOf(update), {
        sensitivity: 'special',
        unattended: 'never',
      }),
    });
    expect(() => issueProof(special, 'echo', 2_000)).toThrow(TypeError);
  });

  it('confirms nothing by echo once the plan derived again forbids it', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'echo', 2_000);
    expect(useProof(proof, { ...viewOf(plan), echo: false })).toBeUndefined();
  });

  it('is never issued by the policy for a write of the Pro module or a special one', () => {
    const pro = sealPlan(inputOf(groupAdd, { tool: 'ct_groups_add_member' }));
    expect(() => issueProof(pro, 'policy', 2_000)).toThrow(TypeError);
    const never = sealed({
      rules: withToolMeta(rulesOf(update), {
        sensitivity: 'personal',
        unattended: 'never',
      }),
    });
    expect(() => issueProof(never, 'policy', 2_000)).toThrow(TypeError);
    // The client and the operator may confirm a write of the Pro module.
    expect(isProof(issueProof(pro, 'operator', 2_000))).toBe(true);
  });

  it('is not issued for a lookalike of a plan, an unknown way or no time', () => {
    const plan = sealed();
    for (const value of lookalikes(plan)) {
      expect(() =>
        issueProof(value as PlannedWrite, 'elicitation', 2_000),
      ).toThrow(TypeError);
    }
    expect(() => issueProof(plan, 'magic' as ConfirmationPath, 2_000)).toThrow(
      TypeError,
    );
    expect(() => issueProof(plan, 'elicitation', Number.NaN)).toThrow(
      TypeError,
    );
  });

  it('is told apart from every lookalike and confirms nothing as one', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'elicitation', 2_000);
    for (const value of lookalikes(proof)) {
      expect(isProof(value)).toBe(false);
      expect(useProof(value, viewOf(plan))).toBeUndefined();
    }
    // The lookalikes did not use the proof up.
    expect(useProof(proof, viewOf(plan))).toBe('elicitation');
  });

  it('can be neither made nor used through its class', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'elicitation', 2_000);
    const Class = (proof as object).constructor as unknown as {
      new (key: symbol, view: unknown): object;
      use(key: symbol, value: unknown): unknown;
    };
    expect(() => new Class(Symbol('ecclium.proof'), {})).toThrow(TypeError);
    expect(Class.use(Symbol('ecclium.proof'), proof)).toBeUndefined();
    expect(Object.isFrozen(Class)).toBe(true);
    expect(JSON.stringify(proof)).toBe('{}');
    // Trying through the class did not use it up.
    expect(useProof(proof, viewOf(plan))).toBe('elicitation');
  });
});
