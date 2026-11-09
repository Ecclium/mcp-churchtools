import { describe, expect, it } from 'vitest';

import { isUuid } from '../logger/index.js';
import { createRunId, runAssignmentOf } from './id.js';

// The ID of a run and the actor of a routine (ADR 0033).

describe('the ID of a run', () => {
  it('is a new UUID each time', () => {
    const first = createRunId();
    expect(isUuid(first)).toBe(true);
    expect(createRunId()).not.toBe(first);
  });
});

describe('the actor of a routine', () => {
  it('is runner:<ID> in the tenant of self-hosting', () => {
    const assignment = runAssignmentOf('dienstplan-report');
    expect(assignment).toEqual({
      tenantId: 'default',
      actor: { kind: 'runner', id: 'runner:dienstplan-report' },
    });
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment.actor)).toBe(true);
  });

  it('refuses an ID of another form', () => {
    for (const id of ['Dienstplan', '', 'a'.repeat(64), 7]) {
      expect(() => runAssignmentOf(id as string)).toThrow(TypeError);
    }
  });
});
