import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type AuditEventV1,
  type AuditType,
  type ContentViolationKind,
  contentViolationKinds,
  type ErrorCode,
  errorCodes,
} from './index.js';

// Lists every code once. A code missing here fails the type check, a code
// missing from errorCodes fails the comparison below.
const everyCode: Readonly<Record<ErrorCode, true>> = {
  config: true,
  auth: true,
  permission: true,
  not_found: true,
  validation: true,
  conflict: true,
  rate_limited: true,
  upstream: true,
  network: true,
  policy_denied: true,
  confirmation_required: true,
  license_required: true,
  internal: true,
};

describe('errorCodes', () => {
  it('lists every error code exactly once', () => {
    expect([...errorCodes].sort()).toEqual(Object.keys(everyCode).sort());
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(errorCodes)).toBe(true);
    expect(() => {
      (errorCodes as ErrorCode[]).push('internal');
    }).toThrow(TypeError);
  });
});

describe('AuditEventV1', () => {
  it('has exactly the fields of version 1, none for content', () => {
    expectTypeOf<keyof AuditEventV1>().toEqualTypeOf<
      | 'v'
      | 'eventId'
      | 'ts'
      | 'type'
      | 'undoes'
      | 'queueId'
      | 'decision'
      | 'tenantId'
      | 'actor'
      | 'mode'
      | 'runId'
      | 'routineId'
      | 'tool'
      | 'outcome'
      | 'confirmation'
      | 'writeState'
      | 'policyHash'
      | 'provider'
      | 'pluginHashes'
      | 'dataProtectionRegime'
      | 'objectRefs'
      | 'objectRefsOmitted'
      | 'errorCode'
      | 'contentViolations'
      | 'withheldAfterRead'
      | 'durationMs'
      | 'seq'
      | 'prevHash'
    >();
  });

  it('records a call of a tool, an undo or a decision about the queue (ADR 0031)', () => {
    expectTypeOf<AuditType>().toEqualTypeOf<
      'tool_call' | 'undo' | 'approval'
    >();
    expectTypeOf<AuditEventV1['undoes']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditEventV1['queueId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditEventV1['decision']>().toEqualTypeOf<
      'approved' | 'rejected' | undefined
    >();
  });

  it('accepts only a known error code and version 1', () => {
    const event = (errorCode: string): Partial<AuditEventV1> => ({
      // @ts-expect-error: only the stable codes are allowed
      errorCode,
      // @ts-expect-error: this type describes version 1 only
      v: 2,
    });
    expect(event).toBeTypeOf('function');
  });

  it('cannot be changed through its type', () => {
    const change = (event: AuditEventV1): void => {
      // @ts-expect-error: an event is written once
      event.outcome = 'ok';
      // @ts-expect-error: the objects are a read-only list
      event.objectRefs[0] = 'person-id-1';
    };
    expect(change).toBeTypeOf('function');
  });
});

describe('contentViolationKinds', () => {
  it('names every reason of the content policy once, frozen', () => {
    const every: Record<ContentViolationKind, true> = {
      tooLong: true,
      unparsable: true,
      html: true,
      image: true,
      link: true,
      mention: true,
      reference: true,
      webAddress: true,
      contact: true,
      masked: true,
      unsupported: true,
      tooDeep: true,
      marking: true,
    };
    expect([...contentViolationKinds].sort()).toEqual(
      Object.keys(every).sort(),
    );
    expect(Object.isFrozen(contentViolationKinds)).toBe(true);
  });
});
