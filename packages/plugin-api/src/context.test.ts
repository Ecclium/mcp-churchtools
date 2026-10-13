import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Clock,
  Identity,
  LogFields,
  Logger,
  RunId,
  TenantAssignment,
  TenantContext,
  TenantId,
  TenantResolver,
} from './index.js';

// These are type tests: the type check of the tests fails when a line
// marked with @ts-expect-error compiles, so the functions below never need
// to run.

describe('TenantContext', () => {
  it('has the fields that ADR 0003 names, and the run of the runner', () => {
    expectTypeOf<keyof TenantContext>().toEqualTypeOf<
      | 'tenantId'
      | 'instance'
      | 'actor'
      | 'mode'
      | 'runId'
      | 'redaction'
      | 'readOnly'
      | 'features'
      | 'clock'
      | 'signal'
      | 'log'
    >();
  });

  it('cannot be changed through its type', () => {
    const change = (ctx: TenantContext, other: TenantId): void => {
      // @ts-expect-error: only the composition root sets the mode
      ctx.mode = 'unattended';
      // @ts-expect-error: the tenant comes from a checked source only
      ctx.tenantId = other;
      // @ts-expect-error: the actor is read-only, also inside
      ctx.actor.id = 'someone-else';
      // @ts-expect-error: the features are a read-only list
      ctx.features[0] = 'pro';
      // @ts-expect-error: redaction cannot be lowered by a tool
      ctx.redaction = 'off';
    };
    expect(change).toBeTypeOf('function');
  });

  it('keeps the instance as a string and the features as a list', () => {
    expectTypeOf<TenantContext['instance']>().toEqualTypeOf<string>();
    expectTypeOf<TenantContext['features']>().toEqualTypeOf<
      readonly string[]
    >();
  });
});

describe('TenantId', () => {
  it('does not accept a plain string', () => {
    // @ts-expect-error: a string from a tool input is no tenant
    const id: TenantId = 'default';
    expect(id).toBe('default');
  });

  it('is still a string', () => {
    expectTypeOf<TenantId>().toExtend<string>();
  });

  it('is no RunId, and a RunId is no TenantId', () => {
    expectTypeOf<RunId>().not.toExtend<TenantId>();
    expectTypeOf<TenantId>().not.toExtend<RunId>();
  });
});

describe('Identity and TenantResolver', () => {
  it('know only the sources and scopes of ADR 0037', () => {
    expectTypeOf<Identity['source']>().toEqualTypeOf<
      'stdio' | 'bearer' | 'oauth'
    >();
    expectTypeOf<Identity['scopes']>().toEqualTypeOf<
      readonly ('read' | 'write')[]
    >();
  });

  it('let the resolver refuse an identity with undefined', () => {
    expectTypeOf<ReturnType<TenantResolver['resolve']>>().toEqualTypeOf<
      Promise<TenantAssignment | undefined>
    >();
  });
});

describe('Logger and Clock', () => {
  it('take only plain values as fields', () => {
    // @ts-expect-error: an object could carry content
    const fields: LogFields = { body: { name: 'Person A' } };
    expect(fields).toBeTypeOf('object');
  });

  it('log an event name with optional fields', () => {
    expectTypeOf<Logger['info']>().toEqualTypeOf<
      (event: string, fields?: LogFields) => void
    >();
  });

  it('give the time as a number', () => {
    expectTypeOf<ReturnType<Clock['now']>>().toEqualTypeOf<number>();
  });
});
