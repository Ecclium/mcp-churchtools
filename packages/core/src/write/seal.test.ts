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
const personal = { sensitivity: 'personal', unattended: 'policy' } as const;

const inputOf = (
  intent: unknown,
  change: Partial<PlanInput> = {},
): PlanInput => ({
  tenantId: 'demo-tenant',
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  tool: 'ct_wiki_page_update',
  origin: 'core',
  intent: intent as WriteIntent,
  toolMeta: personal,
  contentHash: contentHashOf(['# Plan']),
  sealedAt: 1_000,
  snapshots: true,
  ...change,
});

const sealed = (change: Partial<PlanInput> = {}): PlannedWrite =>
  sealPlan(inputOf(update, change));

const viewOf = (plan: PlannedWrite): PlanView => {
  const view = readPlan(plan);
  if (view === undefined) throw new Error('no plan');
  return view;
};

// A view as a commit could derive it with other rules, for the checks a
// proof makes against the plan of the commit.
const withRules = (
  view: PlanView,
  change: Partial<PlanView['rules']>,
): PlanView => ({ ...view, rules: { ...view.rules, ...change } });

// The time of issue of the proofs below, and one within their life.
const issued = 2_000;
const soon = 3_000;

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
  it('derives rules, base version, hash and echo from what it is sealed from', () => {
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
    expect(view.rules).toEqual(rulesOf(update));
    expect(view.baseVersion).toBe(3);
    expect(view.echo).toBe(true);
    // The intent is checked and copied again, frozen.
    expect(view.intent).toEqual(update);
    expect(view.intent).not.toBe(update);
    expect(Object.isFrozen(view.intent)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    // The actor is a copy of its own, frozen.
    expect(view.actor).toEqual(input.actor);
    expect(view.actor).not.toBe(input.actor);
    expect(Object.isFrozen(view.actor)).toBe(true);
  });

  it('has no base version for a new page', () => {
    const view = viewOf(
      sealPlan(
        inputOf({
          kind: 'wikiPageCreate',
          categoryId: 12,
          title: 'Plan',
          text: '# Plan',
        }),
      ),
    );
    expect(view.baseVersion).toBeNull();
    expect(view.rules.target).toEqual({ kind: 'wiki_category', key: '12' });
  });

  it('takes the stricter metadata of the tool and then allows no echo', () => {
    const view = viewOf(
      sealed({ toolMeta: { sensitivity: 'special', unattended: 'never' } }),
    );
    expect(view.rules).toEqual(
      withToolMeta(rulesOf(update), {
        sensitivity: 'special',
        unattended: 'never',
      }),
    );
    expect(view.echo).toBe(false);
  });

  it('seals a write as not reversible without snapshots, and then allows no echo', () => {
    const view = viewOf(sealed({ snapshots: false }));
    expect(view.rules).toEqual({ ...rulesOf(update), reversible: 'no' });
    expect(view.echo).toBe(false);
    // The hash names the change, not how it can be taken back.
    expect(view.planHash).toBe(viewOf(sealed()).planHash);
  });

  it('allows the echo for no tool of a plugin', () => {
    expect(viewOf(sealed({ origin: 'plugin' })).echo).toBe(false);
  });

  it.each([
    ['an intent that does not fit', { ...update, baseVersion: -1 }],
    [
      'a write of the Pro module',
      { kind: 'groupMemberAdd', groupId: 7, personId: 1 },
    ],
    [
      'an appointment, which the core does not run yet',
      {
        kind: 'appointmentCreate',
        calendarId: 4,
        title: 'Probe',
        startDate: 'a',
        endDate: 'b',
      },
    ],
  ])('is not sealed from %s', (_name, intent) => {
    expect(() => sealPlan(inputOf(intent))).toThrow(TypeError);
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
});

describe('a proof', () => {
  it.each<ConfirmationPath>(['elicitation', 'operator', 'echo', 'policy'])(
    'confirms its plan once on the way %s',
    (path) => {
      const plan = sealed();
      const proof = issueProof(plan, path, issued);
      expect(isProof(proof)).toBe(true);
      expect(useProof(proof, viewOf(plan), soon)).toBe(path);
      expect(useProof(proof, viewOf(plan), soon)).toBeUndefined();
      // A used proof is still a proof, but it confirms nothing.
      expect(isProof(proof)).toBe(true);
    },
  );

  it('confirms no other plan, and a proof tried on one is used up', () => {
    const plan = sealed();
    const other = sealed({ contentHash: contentHashOf(['# Anders']) });
    const proof = issueProof(plan, 'elicitation', issued);
    expect(useProof(proof, viewOf(other), soon)).toBeUndefined();
    expect(useProof(proof, viewOf(plan), soon)).toBeUndefined();
  });

  it.each([
    ['tenant', { tenantId: 'other-tenant' }],
    ['kind of actor', { actor: { kind: 'user', id: 'stdio:local-stdio' } }],
    ['ID of actor', { actor: { kind: 'service', id: 'stdio:other' } }],
  ] as const)(
    'confirms no plan of another %s, even with the same hash',
    (_name, change) => {
      const plan = sealed();
      const proof = issueProof(plan, 'elicitation', issued);
      expect(
        useProof(proof, { ...viewOf(plan), ...change }, soon),
      ).toBeUndefined();
    },
  );

  it('confirms for 600 seconds from its issue and not after', () => {
    const plan = sealed();
    const fresh = issueProof(plan, 'elicitation', issued);
    expect(useProof(fresh, viewOf(plan), issued + 600_000)).toBe('elicitation');
    for (const now of [issued + 600_001, issued - 1, Number.NaN]) {
      const proof = issueProof(plan, 'elicitation', issued);
      expect(useProof(proof, viewOf(plan), now)).toBeUndefined();
      // Used up all the same.
      expect(useProof(proof, viewOf(plan), soon)).toBeUndefined();
    }
  });

  it('is not issued for the echo where the plan does not allow it', () => {
    expect(() =>
      issueProof(sealed({ origin: 'plugin' }), 'echo', issued),
    ).toThrow(TypeError);
    const special = sealed({
      toolMeta: { sensitivity: 'special', unattended: 'never' },
    });
    expect(() => issueProof(special, 'echo', issued)).toThrow(TypeError);
  });

  it('confirms nothing by echo once the plan derived again forbids it', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'echo', issued);
    expect(
      useProof(proof, { ...viewOf(plan), echo: false }, soon),
    ).toBeUndefined();
  });

  it('is not issued by the policy for a tool that never runs unattended', () => {
    const never = sealed({
      toolMeta: { sensitivity: 'personal', unattended: 'never' },
    });
    expect(() => issueProof(never, 'policy', issued)).toThrow(TypeError);
  });

  it('confirms nothing by the policy for a plan of the Pro module', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'policy', issued);
    expect(
      useProof(proof, withRules(viewOf(plan), { module: 'pro' }), soon),
    ).toBeUndefined();
  });

  it.each<ConfirmationPath>(['elicitation', 'operator', 'echo', 'policy'])(
    'confirms nothing on the way %s for an intent the core does not run',
    (path) => {
      const plan = sealed();
      const proof = issueProof(plan, path, issued);
      expect(
        useProof(proof, withRules(viewOf(plan), { runs: false }), soon),
      ).toBeUndefined();
    },
  );

  it.each<[ConfirmationPath, ConfirmationPath | undefined]>([
    ['operator', 'operator'],
    ['elicitation', undefined],
    ['echo', undefined],
    ['policy', undefined],
  ])(
    'confirms a plan that always goes to the queue on the way %s only as the operator',
    (path, expected) => {
      const plan = sealed();
      const proof = issueProof(plan, path, issued);
      expect(
        useProof(proof, withRules(viewOf(plan), { alwaysQueue: true }), soon),
      ).toBe(expected);
    },
  );

  it('is not issued for a lookalike of a plan, an unknown way or no time', () => {
    const plan = sealed();
    for (const value of lookalikes(plan)) {
      expect(() =>
        issueProof(value as PlannedWrite, 'elicitation', issued),
      ).toThrow(TypeError);
    }
    expect(() => issueProof(plan, 'magic' as ConfirmationPath, issued)).toThrow(
      TypeError,
    );
    expect(() => issueProof(plan, 'elicitation', Number.NaN)).toThrow(
      TypeError,
    );
  });

  it('is told apart from every lookalike and confirms nothing as one', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'elicitation', issued);
    for (const value of lookalikes(proof)) {
      expect(isProof(value)).toBe(false);
      expect(useProof(value, viewOf(plan), soon)).toBeUndefined();
    }
    // The lookalikes did not use the proof up.
    expect(useProof(proof, viewOf(plan), soon)).toBe('elicitation');
  });

  it('can be neither made nor used through its class', () => {
    const plan = sealed();
    const proof = issueProof(plan, 'elicitation', issued);
    const Class = (proof as object).constructor as unknown as {
      new (key: symbol, view: unknown): object;
      use(key: symbol, value: unknown): unknown;
    };
    expect(() => new Class(Symbol('ecclium.proof'), {})).toThrow(TypeError);
    expect(Class.use(Symbol('ecclium.proof'), proof)).toBeUndefined();
    expect(Object.isFrozen(Class)).toBe(true);
    expect(JSON.stringify(proof)).toBe('{}');
    // Trying through the class did not use it up.
    expect(useProof(proof, viewOf(plan), soon)).toBe('elicitation');
  });
});
