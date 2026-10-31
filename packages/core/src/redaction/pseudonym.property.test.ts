import { createHash } from 'node:crypto';

import type {
  KeyProvider,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { openPseudonyms } from './pseudonym.js';
import { pseudonymPattern } from './pseudonym-form.js';

// Property tests of the pseudonyms of the level strict (ADR 0069, ADR
// 0070): every ID comes back, two IDs, two principals, two tenants and
// two days far enough apart never share a pseudonym, and a pseudonym with
// any one sign changed opens to nothing. A fixed seed keeps the runs the
// same in CI.

const seed = 70_006;
const run = { seed, numRuns: 100 };

// The secret is made from a seed instead of written out, so that no
// secret scanner reads a test secret as a leaked one.
const keys: KeyProvider = createFileKeyProvider({
  current: new KeyMaterial(
    createHash('sha256').update('pseudonym-properties').digest('hex'),
  ),
});

const noon = Date.UTC(2026, 9, 31, 12);
const dayMs = 24 * 60 * 60 * 1000;

const context = (
  time: number,
  actor = 'stdio:local-stdio',
  tenantId = 'default',
): TenantContext =>
  Object.freeze({
    tenantId,
    instance: 'https://example.church.tools',
    actor: Object.freeze({ kind: 'user', id: actor }),
    clock: Object.freeze({ now: () => time }),
  }) as unknown as TenantContext;

const hide = async (ctx: TenantContext, id: number): Promise<string> => {
  const pseudonyms = await openPseudonyms(keys, ctx);
  try {
    return pseudonyms.hide(id);
  } finally {
    pseudonyms.erase();
  }
};

const reveal = async (
  ctx: TenantContext,
  text: unknown,
): Promise<number | undefined> => {
  const pseudonyms = await openPseudonyms(keys, ctx);
  try {
    return pseudonyms.reveal(text);
  } finally {
    pseudonyms.erase();
  }
};

const ids = fc.oneof(
  fc.integer({ min: 0, max: 100_000 }),
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
);
const actors = fc
  .stringMatching(/^[a-z0-9-]{1,20}$/)
  .map((subject) => `stdio:${subject}`);
const pattern = new RegExp(pseudonymPattern, 'u');
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

describe('the pseudonyms', () => {
  it('take every ID back, in the form of the schema', async () => {
    await fc.assert(
      fc.asyncProperty(ids, async (id) => {
        const pseudonym = await hide(context(noon), id);
        expect(pseudonym).toMatch(pattern);
        expect(await reveal(context(noon), pseudonym)).toBe(id);
        expect(await reveal(context(noon + dayMs), pseudonym)).toBe(id);
      }),
      run,
    );
  });

  it('differ for two IDs, two principals and two tenants', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(ids, { minLength: 2, maxLength: 2 }),
        fc.uniqueArray(actors, { minLength: 2, maxLength: 2 }),
        async ([first = 0, second = 1], [one = 'a', other = 'b']) => {
          const own = await hide(context(noon, one), first);
          expect(await hide(context(noon, one), second)).not.toBe(own);
          expect(await hide(context(noon, other), first)).not.toBe(own);
          expect(await hide(context(noon, one, 'other'), first)).not.toBe(own);
          expect(await reveal(context(noon, other), own)).toBeUndefined();
          expect(
            await reveal(context(noon, one, 'other'), own),
          ).toBeUndefined();
        },
      ),
      run,
    );
  });

  it('change with the day and open no more two days later', async () => {
    await fc.assert(
      fc.asyncProperty(
        ids,
        fc.integer({ min: 2, max: 400 }),
        async (id, days) => {
          const pseudonym = await hide(context(noon), id);
          const later = context(noon + days * dayMs);
          expect(await hide(later, id)).not.toBe(pseudonym);
          expect(await reveal(later, pseudonym)).toBeUndefined();
        },
      ),
      run,
    );
  });

  it('open to nothing with any one sign changed, added or taken away', async () => {
    await fc.assert(
      fc.asyncProperty(
        ids,
        fc.nat(),
        fc.integer({ min: 1, max: alphabet.length - 1 }),
        fc.constantFrom('replace', 'upper', 'append', 'drop'),
        async (id, at, shift, change) => {
          const pseudonym = await hide(context(noon), id);
          const index = 3 + (at % (pseudonym.length - 3));
          const sign = pseudonym.charAt(index);
          const next = alphabet.charAt(
            (alphabet.indexOf(sign) + shift) % alphabet.length,
          );
          const changed =
            change === 'replace'
              ? pseudonym.slice(0, index) + next + pseudonym.slice(index + 1)
              : change === 'upper'
                ? pseudonym.toUpperCase()
                : change === 'append'
                  ? `${pseudonym}${next}`
                  : pseudonym.slice(0, -1);
          expect(changed).not.toBe(pseudonym);
          expect(await reveal(context(noon), changed)).toBeUndefined();
        },
      ),
      run,
    );
  });
});
