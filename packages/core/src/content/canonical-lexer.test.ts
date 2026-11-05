import { describe, expect, it, vi } from 'vitest';

import type { TopLevelPart } from './lexer.js';

// The lexer of marked has never been seen to fail on a text of the limit
// or to leave a part of it out (fuzzed with 200'000 texts), so this test
// stands in for both, to show that such a page counts as unreadable.
const parts = vi.hoisted(
  (): { value: readonly TopLevelPart[] | undefined } => ({ value: undefined }),
);
vi.mock(import('./lexer.js'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, readTopLevel: () => parts.value };
});

const { canonicalPartsOf } = await import('./canonical.js');

describe('canonicalPartsOf with a lexer that fails', () => {
  it('reads no page when the lexer fails or its parts do not cover the text', () => {
    parts.value = undefined;
    expect(canonicalPartsOf('Text.')).toBeUndefined();
    parts.value = [
      {
        type: 'paragraph',
        source: 'Tex',
        node: undefined,
        violations: new Set(),
        markup: false,
      },
    ];
    expect(canonicalPartsOf('Text.')).toBeUndefined();
  });
});
