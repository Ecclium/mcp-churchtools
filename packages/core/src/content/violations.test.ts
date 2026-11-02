import { describe, expect, it } from 'vitest';

import {
  contentSentences,
  contentViolationKinds,
  orderViolations,
} from './violations.js';

describe('contentSentences', () => {
  it('has one English sentence for every reason and no other', () => {
    expect(Object.keys(contentSentences).sort()).toEqual(
      [...contentViolationKinds].sort(),
    );
    for (const sentence of Object.values(contentSentences)) {
      expect(sentence).toMatch(/^The (text|server) /u);
      expect(sentence.endsWith('.')).toBe(true);
      // Only ASCII, like every text for the model.
      expect(Buffer.byteLength(sentence)).toBe(sentence.length);
    }
    expect(Object.isFrozen(contentSentences)).toBe(true);
    expect(Object.isFrozen(contentViolationKinds)).toBe(true);
  });
});

describe('orderViolations', () => {
  it('puts reasons into the fixed order and names each once', () => {
    const ordered = orderViolations(['link', 'html', 'link', 'tooDeep']);
    expect(ordered).toEqual(['html', 'link', 'tooDeep']);
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(orderViolations([])).toEqual([]);
  });
});
