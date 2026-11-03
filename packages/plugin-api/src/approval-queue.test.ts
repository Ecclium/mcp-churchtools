import { describe, expect, it } from 'vitest';

import { maxSealedQueueEntryLength, queueDecisionKinds } from './index.js';

describe('the port of the queue of approvals', () => {
  it('knows two decisions, frozen', () => {
    expect(queueDecisionKinds).toEqual(['approved', 'rejected']);
    expect(Object.isFrozen(queueDecisionKinds)).toBe(true);
  });

  it('bounds a sealed entry as a snapshot is bounded', () => {
    expect(maxSealedQueueEntryLength).toBe(16 * 1024 * 1024);
  });
});
