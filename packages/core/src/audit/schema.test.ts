import type {
  ActorKind,
  AuditEventV1,
  AuditOutcome,
  AuditRunResult,
  AuditRunStep,
  AuditType,
  ConfirmationPath,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import {
  actorKinds,
  auditEventJsonSchema,
  auditEventV1Schema,
  auditFieldSchemas as fields,
  auditLimits,
  auditOutcomes,
  auditPlaceholders,
  auditTypes,
  confirmationPaths,
  objectDomains,
  writeStateOutcomes,
  writeStates,
} from './index.js';
// The audit index does not pass these two lists on, so the test reads them
// where they are made.
import { auditRunResults, auditRunSteps } from './schema.js';

// Lists every value once. A value missing here fails the type check, a
// value missing from the frozen list fails the comparison below.
const everyActorKind: Readonly<Record<ActorKind, true>> = {
  service: true,
  user: true,
  runner: true,
  operator: true,
};
const everyType: Readonly<Record<AuditType, true>> = {
  tool_call: true,
  undo: true,
  approval: true,
  run: true,
  adoption: true,
};
const everyRunResult: Readonly<Record<AuditRunResult, true>> = {
  written: true,
  unchanged: true,
  queued: true,
  drafted: true,
  preview: true,
  failed: true,
};
const everyRunStep: Readonly<Record<AuditRunStep, true>> = {
  input: true,
  model: true,
  answer: true,
  content: true,
  write: true,
};
const everyOutcome: Readonly<Record<AuditOutcome, true>> = {
  ok: true,
  error: true,
  denied: true,
};
const everyConfirmation: Readonly<Record<ConfirmationPath, true>> = {
  elicitation: true,
  echo: true,
  policy: true,
  operator: true,
};

const valid: AuditEventV1 = {
  v: 1,
  eventId: 'a1b2c3d4-0000-4000-8000-000000000001',
  ts: '2026-10-13T08:00:00.000Z',
  type: 'tool_call',
  tenantId: 'demo-tenant',
  actor: { kind: 'user', id: 'stdio:local-stdio' },
  mode: 'interactive',
  outcome: 'ok',
  objectRefs: ['person:1'],
  durationMs: 12,
};

// An undo of ecclium undo: it names the write it takes back and calls no
// tool (ADR 0031). The type of an event does not hold that rule, the
// schema does.
const unnamedUndo: AuditEventV1 = {
  ...valid,
  type: 'undo',
  actor: { kind: 'operator', id: 'stdio:local-stdio' },
  mode: 'operator',
  confirmation: 'operator',
  writeState: 'verified',
  objectRefs: ['wiki_category:12', 'wiki_page:34'],
};
const undo: AuditEventV1 = {
  ...unnamedUndo,
  undoes: 'a1b2c3d4-0000-4000-8000-000000000002',
};

// A rejection of ecclium queue reject: it names the entry and what was
// decided, calls no tool and wrote nothing (ADR 0031).
const rejection: AuditEventV1 = {
  ...valid,
  type: 'approval',
  actor: { kind: 'operator', id: 'stdio:local-stdio' },
  mode: 'operator',
  queueId: 'a1b2c3d4-0000-4000-8000-000000000003',
  decision: 'rejected',
  objectRefs: ['wiki_category:12'],
};

// The end of a run of a routine: it names its run and how it ended, and
// calls no tool, writes nothing of its own and needs no confirmation
// (ADR 0033).
const runEnd: AuditEventV1 = {
  ...valid,
  type: 'run',
  tenantId: 'default',
  actor: { kind: 'runner', id: 'runner:weekly-report' },
  mode: 'unattended',
  runId: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
  routineId: 'weekly-report',
  objectRefs: [],
  runResult: 'written',
};
// An adoption of ecclium marker adopt: it names the run whose section it
// signs anew and its page, and calls no tool (ADR 0032).
const adoption: AuditEventV1 = {
  ...valid,
  type: 'adoption',
  actor: { kind: 'operator', id: 'stdio:local-stdio' },
  mode: 'operator',
  runId: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
  routineId: 'weekly-report',
  confirmation: 'operator',
  writeState: 'verified',
  objectRefs: ['wiki_category:12', 'wiki_page:34'],
};
// The same run, failed in a step with an error code.
const failedRun: AuditEventV1 = {
  ...runEnd,
  outcome: 'error',
  errorCode: 'upstream',
  runResult: 'failed',
  runStep: 'model',
};

const passes = (schema: z.ZodType, value: unknown): boolean =>
  schema.safeParse(value).success;

describe('auditEventV1Schema', () => {
  it('has the type of AuditEventV1, for output and input', () => {
    expectTypeOf<
      z.output<typeof auditEventV1Schema>
    >().toEqualTypeOf<AuditEventV1>();
    expectTypeOf<
      z.input<typeof auditEventV1Schema>
    >().toEqualTypeOf<AuditEventV1>();
  });

  it('accepts a valid event and one with every optional field', () => {
    expect(passes(auditEventV1Schema, valid)).toBe(true);
    const full: AuditEventV1 = {
      ...valid,
      runId: '0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
      routineId: 'weekly-report',
      tool: 'ct_group_search',
      outcome: 'denied',
      confirmation: 'elicitation',
      policyHash: 'a'.repeat(64),
      provider: {
        vendor: 'example-ai',
        model: 'example-model-1',
        hostingCountry: 'CH',
        endpointHost: 'api.example.org',
        transferBasis: 'adequacy_decision',
      },
      pluginHashes: ['b'.repeat(64)],
      dataProtectionRegime: 'ch_dsg',
      errorCode: 'policy_denied',
      contentViolations: ['html', 'link'],
      seq: 1,
      prevHash: 'c'.repeat(64),
    };
    expect(passes(auditEventV1Schema, full)).toBe(true);
  });

  it('takes the reasons of a refused text only on a refusal, never empty', () => {
    const refused = {
      ...valid,
      outcome: 'denied',
      errorCode: 'validation',
    } as const;
    expect(
      passes(auditEventV1Schema, {
        ...refused,
        contentViolations: ['contact'],
      }),
    ).toBe(true);
    expect(
      passes(auditEventV1Schema, { ...valid, contentViolations: ['contact'] }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...refused, contentViolations: [] }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...refused, contentViolations: ['shout'] }),
    ).toBe(false);
  });

  it('takes an undo that names the write it takes back, without a tool (ADR 0031)', () => {
    expect(passes(auditEventV1Schema, undo)).toBe(true);
    expect(
      passes(auditEventV1Schema, {
        ...undo,
        outcome: 'error',
        errorCode: 'conflict',
        writeState: 'conflict',
        seq: 2,
        prevHash: 'c'.repeat(64),
      }),
    ).toBe(true);
    // A tool call keeps its rule: the tool may be missing.
    expect(valid).not.toHaveProperty('tool');
    expect(passes(auditEventV1Schema, valid)).toBe(true);
  });

  it('ties undoes to the type undo, both ways (ADR 0031)', () => {
    expect(passes(auditEventV1Schema, unnamedUndo)).toBe(false);
    expect(passes(auditEventV1Schema, { ...undo, undoes: undefined })).toBe(
      false,
    );
    expect(passes(auditEventV1Schema, { ...valid, undoes: undo.undoes })).toBe(
      false,
    );
    expect(passes(auditEventV1Schema, { ...valid, undoes: undefined })).toBe(
      true,
    );
    for (const undoes of ['not-a-uuid', undo.undoes?.toUpperCase(), 1, null]) {
      expect(
        passes(auditEventV1Schema, { ...undo, undoes }),
        String(undoes),
      ).toBe(false);
    }
  });

  it('refuses a tool on an undo (ADR 0031)', () => {
    for (const tool of ['ct_wiki_page_update', auditPlaceholders.tool]) {
      expect(passes(auditEventV1Schema, { ...undo, tool }), tool).toBe(false);
    }
    expect(passes(auditEventV1Schema, { ...undo, tool: undefined })).toBe(true);
  });

  it('takes a decision about an entry of the queue that names it and what was decided, without a tool (ADR 0031)', () => {
    expect(passes(auditEventV1Schema, rejection)).toBe(true);
    expect(
      passes(auditEventV1Schema, {
        ...rejection,
        outcome: 'error',
        errorCode: 'not_found',
      }),
    ).toBe(true);
    // An approval that wrote names its state and its way.
    expect(
      passes(auditEventV1Schema, {
        ...rejection,
        decision: 'approved',
        confirmation: 'operator',
        writeState: 'verified',
      }),
    ).toBe(true);
  });

  it('ties queueId and decision to the type approval, both ways (ADR 0031)', () => {
    for (const missing of [
      { ...rejection, queueId: undefined },
      { ...rejection, decision: undefined },
      { ...valid, queueId: rejection.queueId },
      { ...valid, decision: 'rejected' },
      { ...undo, queueId: rejection.queueId, decision: 'rejected' },
    ]) {
      expect(passes(auditEventV1Schema, missing)).toBe(false);
    }
    for (const queueId of ['not-a-uuid', rejection.queueId?.toUpperCase(), 1]) {
      expect(
        passes(auditEventV1Schema, { ...rejection, queueId }),
        String(queueId),
      ).toBe(false);
    }
    for (const decision of ['maybe', 'Rejected', 1, null]) {
      expect(
        passes(auditEventV1Schema, { ...rejection, decision }),
        String(decision),
      ).toBe(false);
    }
  });

  it('refuses a tool on a decision and a state or way of a write on a rejection (ADR 0031)', () => {
    expect(
      passes(auditEventV1Schema, { ...rejection, tool: 'ct_wiki_page_update' }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...rejection, writeState: 'verified' }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...rejection, confirmation: 'operator' }),
    ).toBe(false);
  });

  it('takes the end of a run with every result but failed as ok (ADR 0033)', () => {
    for (const runResult of auditRunResults) {
      if (runResult === 'failed') continue;
      expect(
        passes(auditEventV1Schema, { ...runEnd, runResult }),
        runResult,
      ).toBe(true);
    }
    // A run by hand has no try and no period, a run of the schedule has
    // both, and the routine and the model are optional.
    expect(
      passes(auditEventV1Schema, {
        ...runEnd,
        attempt: 2,
        period: '2026-W46',
        egressOff: true,
        policyHash: 'a'.repeat(64),
        provider: {
          vendor: 'example-ai',
          model: 'example-model-1',
          hostingCountry: 'CH',
          endpointHost: 'api.example.org',
        },
      }),
    ).toBe(true);
    expect(
      passes(auditEventV1Schema, { ...runEnd, routineId: undefined }),
    ).toBe(true);
  });

  it('takes a failed run with any step, error or denied (ADR 0033)', () => {
    expect(passes(auditEventV1Schema, failedRun)).toBe(true);
    for (const runStep of auditRunSteps) {
      expect(
        passes(auditEventV1Schema, { ...failedRun, runStep }),
        runStep,
      ).toBe(true);
    }
    expect(
      passes(auditEventV1Schema, { ...failedRun, runStep: undefined }),
    ).toBe(true);
    // A run the content policy refused says denied, with its reasons.
    expect(
      passes(auditEventV1Schema, {
        ...failedRun,
        outcome: 'denied',
        errorCode: 'validation',
        runStep: 'content',
        contentViolations: ['link'],
      }),
    ).toBe(true);
  });

  it('ties failed to an outcome that is not ok, both ways (ADR 0033)', () => {
    // Each case changes one thing of a valid line and keeps every other
    // rule, so that only the rule of the result can refuse it.
    for (const runResult of auditRunResults) {
      if (runResult === 'failed') continue;
      for (const outcome of ['error', 'denied'] as const) {
        expect(
          passes(auditEventV1Schema, {
            ...runEnd,
            runResult,
            outcome,
            errorCode: 'internal',
          }),
          `${runResult} ${outcome}`,
        ).toBe(false);
      }
    }
    expect(
      passes(auditEventV1Schema, {
        ...failedRun,
        outcome: 'ok',
        errorCode: undefined,
        runStep: undefined,
      }),
    ).toBe(false);
  });

  it('takes a step only on a failed run (ADR 0033)', () => {
    expect(passes(auditEventV1Schema, { ...runEnd, runStep: 'write' })).toBe(
      false,
    );
    for (const runStep of ['output', 'Write', 'toString', 1, null]) {
      expect(
        passes(auditEventV1Schema, { ...failedRun, runStep }),
        String(runStep),
      ).toBe(false);
    }
  });

  it('refuses the end of a run without its result or its run (ADR 0033)', () => {
    expect(
      passes(auditEventV1Schema, { ...runEnd, runResult: undefined }),
    ).toBe(false);
    expect(passes(auditEventV1Schema, { ...runEnd, runId: undefined })).toBe(
      false,
    );
    for (const runResult of ['done', 'Written', 'toString', 1, null]) {
      expect(
        passes(auditEventV1Schema, { ...runEnd, runResult }),
        String(runResult),
      ).toBe(false);
    }
  });

  it('refuses a tool, a state of a write and a way of a confirmation on the end of a run (ADR 0033)', () => {
    for (const tool of ['ct_wiki_page_update', auditPlaceholders.tool]) {
      expect(passes(auditEventV1Schema, { ...runEnd, tool }), tool).toBe(false);
    }
    // The state fits the outcome, so only the rule of the run refuses it.
    expect(
      passes(auditEventV1Schema, { ...runEnd, writeState: 'verified' }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...runEnd, confirmation: 'policy' }),
    ).toBe(false);
    expect(passes(auditEventV1Schema, { ...runEnd, tool: undefined })).toBe(
      true,
    );
  });

  it('takes an adoption that names its run, without a tool, and refuses one without its run (ADR 0032)', () => {
    expect(passes(auditEventV1Schema, adoption)).toBe(true);
    // The routine is left out when it is not known, as on the end of a run.
    expect(
      passes(auditEventV1Schema, { ...adoption, routineId: undefined }),
    ).toBe(true);
    // A preview of the operator planned and wrote nothing.
    expect(
      passes(auditEventV1Schema, {
        ...adoption,
        writeState: 'planned',
        confirmation: undefined,
      }),
    ).toBe(true);
    expect(passes(auditEventV1Schema, { ...adoption, runId: undefined })).toBe(
      false,
    );
    for (const tool of ['ct_wiki_page_update', auditPlaceholders.tool]) {
      expect(passes(auditEventV1Schema, { ...adoption, tool }), tool).toBe(
        false,
      );
    }
    // Against the rules of the other types: no write it takes back, no
    // entry of the queue and nothing of the end of a run.
    for (const field of [
      { undoes: undo.undoes },
      { queueId: rejection.queueId, decision: 'approved' },
      { runResult: 'written' },
      { period: '2026-W46' },
    ]) {
      expect(
        passes(auditEventV1Schema, { ...adoption, ...field }),
        Object.keys(field).join(),
      ).toBe(false);
    }
  });

  it('keeps the result, the step, the try and the period to the end of a run (ADR 0033)', () => {
    for (const other of [valid, undo, rejection, adoption]) {
      for (const field of [
        { runResult: 'written' },
        { runStep: 'model' },
        { attempt: 1 },
        { period: '2026-W46' },
        { egressOff: true },
      ]) {
        expect(
          passes(auditEventV1Schema, { ...other, ...field }),
          `${other.type} ${Object.keys(field).join()}`,
        ).toBe(false);
      }
      // Set to undefined, a field counts as absent.
      expect(
        passes(auditEventV1Schema, {
          ...other,
          runResult: undefined,
          runStep: undefined,
          attempt: undefined,
          period: undefined,
          egressOff: undefined,
        }),
        other.type,
      ).toBe(true);
    }
  });

  it('refuses another type', () => {
    for (const type of ['other', 'Undo', 'toString', undefined]) {
      expect(passes(auditEventV1Schema, { ...valid, type }), type).toBe(false);
    }
  });

  it('counts seq from 1, as the chain of a file does', () => {
    expect(passes(auditEventV1Schema, { ...valid, seq: 0 })).toBe(false);
    expect(passes(auditEventV1Schema, { ...valid, seq: 1.5 })).toBe(false);
    expect(passes(auditEventV1Schema, { ...valid, seq: 1 })).toBe(true);
  });

  it('refuses an unknown key, also inside actor and provider', () => {
    expect(passes(auditEventV1Schema, { ...valid, note: 'x' })).toBe(false);
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        actor: { ...valid.actor, name: 'Max Mustermann' },
      }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        provider: {
          vendor: 'example-ai',
          model: 'example-model-1',
          hostingCountry: 'CH',
          endpointHost: 'api.example.org',
          apiKey: 'x',
        },
      }),
    ).toBe(false);
  });

  it('ties the error code to the outcome', () => {
    expect(
      passes(auditEventV1Schema, { ...valid, errorCode: 'internal' }),
    ).toBe(false);
    expect(passes(auditEventV1Schema, { ...valid, outcome: 'error' })).toBe(
      false,
    );
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        outcome: 'error',
        errorCode: 'upstream',
      }),
    ).toBe(true);
  });

  it('ties the state of a write to the outcome (ADR 0029)', () => {
    for (const [writeState, outcome] of Object.entries(writeStateOutcomes)) {
      const event = {
        ...valid,
        outcome,
        writeState,
        ...(outcome === 'ok' ? {} : { errorCode: 'conflict' }),
      };
      expect(passes(auditEventV1Schema, event)).toBe(true);
      const other = outcome === 'ok' ? 'denied' : 'ok';
      expect(
        passes(auditEventV1Schema, {
          ...event,
          outcome: other,
          ...(other === 'ok'
            ? { errorCode: undefined }
            : { errorCode: 'conflict' }),
        }),
      ).toBe(false);
    }
  });

  it('bounds its lists', () => {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => `person:${String(index)}`);
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        objectRefs: refs(auditLimits.objectRefs),
      }),
    ).toBe(true);
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        objectRefs: refs(auditLimits.objectRefs + 1),
      }),
    ).toBe(false);
    const hashes = (count: number) =>
      Array.from({ length: count }, () => 'a'.repeat(64));
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        pluginHashes: hashes(auditLimits.pluginHashes),
      }),
    ).toBe(true);
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        pluginHashes: hashes(auditLimits.pluginHashes + 1),
      }),
    ).toBe(false);
  });

  it('lets every placeholder pass', () => {
    const placeholders = auditPlaceholders;
    const event = {
      v: 1,
      eventId: placeholders.eventId,
      ts: placeholders.ts,
      type: placeholders.type,
      tenantId: placeholders.tenantId,
      actor: placeholders.actor,
      mode: placeholders.mode,
      tool: placeholders.tool,
      outcome: placeholders.outcome,
      objectRefs: placeholders.objectRefs,
      errorCode: placeholders.errorCode,
      durationMs: placeholders.durationMs,
    };
    expect(passes(auditEventV1Schema, event)).toBe(true);
    // The zero UUID an undo gets for a missing or invalid write.
    expect(
      passes(auditEventV1Schema, {
        ...event,
        tool: undefined,
        type: 'undo',
        undoes: placeholders.undoes,
      }),
    ).toBe(true);
    expect(placeholders.undoes).toBe(placeholders.eventId);
    // The zero UUID and failed that the end of a run gets for a missing or
    // invalid run or result.
    expect(
      passes(auditEventV1Schema, {
        ...event,
        tool: undefined,
        type: 'run',
        runId: placeholders.runId,
        runResult: placeholders.runResult,
      }),
    ).toBe(true);
    expect(placeholders.runId).toBe(placeholders.eventId);
    expect(Object.isFrozen(placeholders)).toBe(true);
    expect(Object.isFrozen(placeholders.actor)).toBe(true);
  });
});

describe('the lists of values', () => {
  it('hold every value once and are frozen', () => {
    expect([...actorKinds].sort()).toEqual(Object.keys(everyActorKind).sort());
    expect(auditTypes).toEqual(Object.keys(everyType));
    expect(auditRunResults).toEqual(Object.keys(everyRunResult));
    // In the order of a run.
    expect(auditRunSteps).toEqual(Object.keys(everyRunStep));
    expect([...auditOutcomes].sort()).toEqual(Object.keys(everyOutcome).sort());
    expect([...confirmationPaths].sort()).toEqual(
      Object.keys(everyConfirmation).sort(),
    );
    expect(writeStates).toEqual([
      'planned',
      'queued',
      'verified',
      'skipped',
      'denied',
      'conflict',
      'failed',
      'rolledBack',
    ]);
    for (const list of [
      actorKinds,
      auditTypes,
      auditRunResults,
      auditRunSteps,
      auditOutcomes,
      confirmationPaths,
      writeStates,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(Object.isFrozen(writeStateOutcomes)).toBe(true);
  });
});

describe('the field schemas', () => {
  it.each([
    [
      'actorId',
      ['stdio:local-stdio', 'service', 'oidc:4f2a-7c'],
      [
        'max.mustermann@example.org',
        'Max Mustermann',
        'stdio:Max',
        'stdio:max.mustermann',
        'a'.repeat(33),
        '',
      ],
    ],
    [
      'objectRef',
      [
        'person:1',
        'group:1234567890123456',
        'wiki_page:0b0e9a3c-3f7e-4c62-9a55-6a1f0d2c7e11',
      ],
      [
        'person-id-1',
        'person:max',
        'person:Max Mustermann',
        'person:12345678901234567',
        'max.mustermann@example.org',
        'Person:1',
        'mustermann:1',
        'max_mustermann:2',
      ],
    ],
    [
      'hash',
      ['a'.repeat(64)],
      ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)],
    ],
    ['vendor', ['example-ai', 'acme'], ['Example', '-ai', 'a'.repeat(33)]],
    [
      'model',
      [
        'example-model-1',
        'model_2.5:latest',
        'example-maker/example-model-1',
        `a/${'b'.repeat(62)}`,
      ],
      [
        '/example-model',
        'example-maker/',
        'example-maker//model',
        'a/b/c',
        'https://api.example.org/v1',
        'sk-ant-key with space',
        'a'.repeat(65),
        `a/${'b'.repeat(63)}`,
      ],
    ],
    ['hostingCountry', ['CH', 'DE'], ['ch', 'CHE', 'C1']],
    [
      'endpointHost',
      ['api.example.org', 'localhost'],
      [
        'https://api.example.org',
        'api.example.org:443',
        'user@api.example.org',
        'api.example.org.',
        'API.example.org',
        'api.example.org/v1',
      ],
    ],
    ['term', ['ch_dsg', 'eu_gdpr'], ['EU GDPR', 'Art. 46 DSGVO', 'eu-gdpr']],
    ['tenantId', ['demo-tenant'], ['Demo', 'demo-tenant\n', 'demo_tenant']],
    [
      'ts',
      ['2026-10-13T08:00:00.000Z'],
      [
        '2026-10-13T08:00:00Z',
        '2026-10-13T08:00:00.000+02:00',
        '+010000-01-01T00:00:00.000Z',
      ],
    ],
  ] as const)(
    '%s accepts what fits and refuses what does not',
    (name, good, bad) => {
      for (const value of good) {
        expect(passes(fields[name], value), value).toBe(true);
      }
      for (const value of bad) {
        expect(passes(fields[name], value), value).toBe(false);
      }
    },
  );

  it('refuses a huge string by its length, before its pattern', () => {
    // The test may read the error; the sink never does.
    const result = fields.tenantId.safeParse(`A${'a'.repeat(10_000_000)}`);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
  });

  it('takes object references only of the listed kinds', () => {
    expect(Object.isFrozen(objectDomains)).toBe(true);
    for (const domain of objectDomains) {
      expect(passes(fields.objectRef, `${domain}:1`), domain).toBe(true);
    }
    for (const domain of [
      'mustermann',
      'persons',
      'events',
      'wiki',
      'tenant',
      'Person',
    ]) {
      expect(passes(fields.objectRef, `${domain}:1`), domain).toBe(false);
    }
  });

  it('lists persons, groups and every kind of object of the plugin API', () => {
    expect([...objectDomains]).toEqual([
      'person',
      'group',
      'event',
      'appointment',
      'calendar',
      'resource',
      'booking',
      'service',
      'song',
      'wiki_category',
      'wiki_page',
    ]);
  });

  it('anchors every alternative of an object reference at both ends', () => {
    for (const value of [
      'person:1',
      'wiki_page:a1b2c3d4-0000-4000-8000-000000000001',
      `song:${'9'.repeat(16)}`,
    ]) {
      expect(passes(fields.objectRef, value), value).toBe(true);
    }
    for (const value of [
      'xperson:1',
      'person:1x',
      'person:1\n',
      'event:1:2',
      'person:max',
      `song:${'9'.repeat(17)}`,
      'wiki_page:A1B2C3D4-0000-4000-8000-000000000001',
      'person:',
      ':1',
    ]) {
      expect(passes(fields.objectRef, value), value).toBe(false);
    }
  });

  it('takes a count of left out IDs only with 100 IDs', () => {
    const hundred = Array.from(
      { length: 100 },
      (_, index) => `person:${String(index)}`,
    );
    expect(
      passes(auditEventV1Schema, {
        ...valid,
        objectRefs: hundred,
        objectRefsOmitted: 3,
      }),
    ).toBe(true);
    expect(passes(auditEventV1Schema, { ...valid, objectRefsOmitted: 3 })).toBe(
      false,
    );
    for (const value of [0, -1, 1.5, 1_000_001, '3']) {
      expect(passes(fields.objectRefsOmitted, value), String(value)).toBe(
        false,
      );
    }
    expect(passes(fields.objectRefsOmitted, 1_000_000)).toBe(true);
  });

  it('takes the mark of a held back result only with denied and policy_denied', () => {
    const withheld = {
      ...valid,
      outcome: 'denied',
      errorCode: 'policy_denied',
      withheldAfterRead: true,
    };
    expect(passes(auditEventV1Schema, withheld)).toBe(true);
    expect(
      passes(auditEventV1Schema, { ...withheld, errorCode: 'validation' }),
    ).toBe(false);
    expect(passes(auditEventV1Schema, { ...withheld, outcome: 'error' })).toBe(
      false,
    );
    expect(
      passes(auditEventV1Schema, { ...valid, withheldAfterRead: true }),
    ).toBe(false);
    expect(
      passes(auditEventV1Schema, { ...withheld, withheldAfterRead: false }),
    ).toBe(false);
  });

  it('refuses inherited names as enumeration values', () => {
    for (const value of ['toString', 'constructor', '__proto__']) {
      expect(passes(fields.errorCode, value)).toBe(false);
      expect(passes(fields.mode, value)).toBe(false);
      expect(passes(fields.actorKind, value)).toBe(false);
    }
  });

  it('takes a try only as a whole number from 1 to 3 (ADR 0034)', () => {
    for (const value of [1, 2, 3]) {
      expect(passes(fields.attempt, value), String(value)).toBe(true);
    }
    for (const value of [0, 4, -1, 1.5, Number.NaN, '1', null]) {
      expect(passes(fields.attempt, value), String(value)).toBe(false);
    }
    expect(passes(auditEventV1Schema, { ...runEnd, attempt: 3 })).toBe(true);
    expect(passes(auditEventV1Schema, { ...runEnd, attempt: 4 })).toBe(false);
  });

  it('takes a period as a week, a day or a month (ADR 0034)', () => {
    for (const value of ['2026-W46', '2026-W01', '2026-11-10', '2026-11']) {
      expect(passes(fields.period, value), value).toBe(true);
    }
    // The pattern checks the form only: a week, a month or a day that does
    // not exist still passes. The runner makes the period, never a model.
    for (const value of ['2026-W99', '2026-13', '2026-02-31']) {
      expect(passes(fields.period, value), value).toBe(true);
    }
    for (const value of [
      '2026-W5',
      '2026-w46',
      '2026-W466',
      '2026-1',
      '2026-11-1',
      '26-11',
      '2026',
      '2026-11-10T08:00',
      '2026-11-10\n',
      // Short enough for the length, so only the anchor at the end refuses it.
      '2026-11\n',
      ' 2026-11',
      'x'.repeat(11),
      '',
      202_611,
      null,
    ]) {
      expect(passes(fields.period, value), String(value)).toBe(false);
    }
  });

  it('refuses a huge period by its length, before its pattern', () => {
    const result = fields.period.safeParse(`2026-11${'1'.repeat(10_000_000)}`);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
  });

  it('takes a duration only as a whole number in its range', () => {
    for (const value of [0, 86_400_000]) {
      expect(passes(fields.durationMs, value)).toBe(true);
    }
    for (const value of [-1, 86_400_001, 1.5, Number.NaN, '12', null]) {
      expect(passes(fields.durationMs, value)).toBe(false);
    }
  });
});

describe('auditEventJsonSchema', () => {
  it('describes the line of the file as a closed object, new on each call', () => {
    const schema = auditEventJsonSchema();
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
    });
    expect(Object.keys(schema['properties'] as object)).toContain(
      'objectRefsOmitted',
    );
    expect(schema['properties']).toMatchObject({
      type: { enum: ['tool_call', 'undo', 'approval', 'run', 'adoption'] },
      runResult: {
        enum: [
          'written',
          'unchanged',
          'queued',
          'drafted',
          'preview',
          'failed',
        ],
      },
      runStep: { enum: ['input', 'model', 'answer', 'content', 'write'] },
      attempt: { type: 'integer', minimum: 1, maximum: 3 },
      period: { type: 'string', maxLength: 10 },
      undoes: { type: 'string', maxLength: 36 },
      queueId: { type: 'string', maxLength: 36 },
      decision: { enum: ['approved', 'rejected'] },
    });
    expect(auditEventJsonSchema()).not.toBe(schema);
    expect(schema).not.toHaveProperty('safeParse');
  });
});
