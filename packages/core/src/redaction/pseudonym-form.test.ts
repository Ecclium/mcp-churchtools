import { createHash } from 'node:crypto';

import type {
  RedactionLevel,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import {
  openPseudonyms,
  pseudonymLength,
  pseudonymPrefix,
} from './pseudonym.js';
import {
  isStrictLevel,
  pseudonymPattern,
  pseudonymTextLength,
} from './pseudonym-form.js';

describe('the form of a pseudonym', () => {
  it('is the one the module of the pseudonyms makes', async () => {
    expect(pseudonymTextLength).toBe(pseudonymLength);
    expect(pseudonymPattern.startsWith(`^${pseudonymPrefix}`)).toBe(true);
    const keys = createFileKeyProvider({
      current: new KeyMaterial(
        createHash('sha256').update('pseudonym-form').digest('hex'),
      ),
    });
    const ctx = {
      tenantId: 'default',
      instance: 'https://example.church.tools',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
      clock: Object.freeze({ now: () => Date.UTC(2026, 9, 31) }),
    } as unknown as TenantContext;
    const pseudonyms = await openPseudonyms(keys, ctx);
    const pattern = new RegExp(pseudonymPattern, 'u');
    try {
      for (const id of [0, 1, 12, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
        const pseudonym = pseudonyms.hide(id);
        expect(pseudonym).toHaveLength(pseudonymTextLength);
        expect(pattern.test(pseudonym), pseudonym).toBe(true);
      }
    } finally {
      pseudonyms.erase();
    }
  });
});

describe('isStrictLevel', () => {
  it('counts strict and a level the core does not know', () => {
    expect(
      (['off', 'standard', 'strict', 'later'] as const).map((level) =>
        isStrictLevel(level as RedactionLevel),
      ),
    ).toEqual([false, false, true, true]);
  });
});
