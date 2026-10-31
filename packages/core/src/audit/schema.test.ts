import type {
  ActorKind,
  AuditEventV1,
  AuditOutcome,
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
  confirmationPaths,
  objectDomains,
} from './index.js';

// Lists every value once. A value missing here fails the type check, a
// value missing from the frozen list fails the comparison below.
const everyActorKind: Readonly<Record<ActorKind, true>> = {
  service: true,
  user: true,
  runner: true,
  operator: true,
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
      seq: 1,
      prevHash: 'c'.repeat(64),
    };
    expect(passes(auditEventV1Schema, full)).toBe(true);
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
    expect(Object.isFrozen(placeholders)).toBe(true);
    expect(Object.isFrozen(placeholders.actor)).toBe(true);
  });
});

describe('the lists of values', () => {
  it('hold every value once and are frozen', () => {
    expect([...actorKinds].sort()).toEqual(Object.keys(everyActorKind).sort());
    expect([...auditOutcomes].sort()).toEqual(Object.keys(everyOutcome).sort());
    expect([...confirmationPaths].sort()).toEqual(
      Object.keys(everyConfirmation).sort(),
    );
    for (const list of [actorKinds, auditOutcomes, confirmationPaths]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
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
      ['example-model-1', 'model_2.5:latest'],
      [
        'meta/llama',
        'https://api.example.org/v1',
        'sk-ant-key with space',
        'a'.repeat(65),
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
    expect(auditEventJsonSchema()).not.toBe(schema);
    expect(schema).not.toHaveProperty('safeParse');
  });
});
