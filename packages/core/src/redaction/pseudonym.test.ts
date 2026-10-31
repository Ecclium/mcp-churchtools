import { createHash } from 'node:crypto';

import type {
  IsoDate,
  KeyProvider,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import {
  openPseudonyms,
  pseudonymLength,
  pseudonymPrefix,
  type Pseudonyms,
  sealGcmSiv,
} from './pseudonym.js';

// The secrets are made from a seed instead of written out, so that no
// secret scanner reads a test secret as a leaked one.
const secret = (seed: string): KeyMaterial =>
  new KeyMaterial(createHash('sha256').update(seed).digest('hex'));
const provider = (seed: string): KeyProvider =>
  createFileKeyProvider({ current: secret(seed) });
const changed: KeyProvider = createFileKeyProvider({
  current: secret('new'),
  previous: secret('old'),
});

const noon = Date.UTC(2026, 9, 31, 12);
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

const context = (
  time: number,
  id = 'stdio:local-stdio',
  tenantId = 'default',
  instance = 'https://example.church.tools',
): TenantContext =>
  Object.freeze({
    tenantId,
    instance,
    actor: Object.freeze({ kind: 'user', id }),
    clock: Object.freeze({ now: () => time }),
  }) as unknown as TenantContext;

// Opens the pseudonyms of one call, runs the body and erases the keys, as
// the pipeline will.
const during = async <T>(
  keys: KeyProvider,
  ctx: TenantContext,
  body: (pseudonyms: Pseudonyms) => T,
): Promise<T> => {
  const pseudonyms = await openPseudonyms(keys, ctx);
  try {
    return body(pseudonyms);
  } finally {
    pseudonyms.erase();
  }
};

const hide = (keys: KeyProvider, ctx: TenantContext, id: number) =>
  during(keys, ctx, (pseudonyms) => pseudonyms.hide(id));
const reveal = (keys: KeyProvider, ctx: TenantContext, text: unknown) =>
  during(keys, ctx, (pseudonyms) => pseudonyms.reveal(text));

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

describe('openPseudonyms', () => {
  it('writes a pseudonym as the prefix and 39 signs of Base32 in lower case', async () => {
    const pseudonym = await hide(provider('a'), context(noon), 1);
    expect(pseudonymPrefix).toBe('p1_');
    expect(pseudonymLength).toBe(42);
    expect(pseudonym).toHaveLength(pseudonymLength);
    expect(pseudonym).toMatch(/^p1_[a-z2-7]{39}$/);
  });

  it('gives the same pseudonym for the same person, principal and day', async () => {
    const first = await hide(provider('a'), context(noon), 7);
    const second = await hide(provider('a'), context(noon + 60_000), 7);
    expect(second).toBe(first);
    expect(await hide(provider('a'), context(noon), 8)).not.toBe(first);
  });

  it.each([0, 1, 7, 2 ** 31, 2 ** 32, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER])(
    'takes the ID %d back',
    async (id) => {
      const pseudonym = await hide(provider('a'), context(noon), id);
      await expect(
        reveal(provider('a'), context(noon), pseudonym),
      ).resolves.toBe(id);
    },
  );

  it('gives two principals different pseudonyms for the same person, and neither opens the other', async () => {
    const mine = await hide(provider('a'), context(noon, 'stdio:a'), 7);
    const yours = await hide(provider('a'), context(noon, 'stdio:b'), 7);
    expect(yours).not.toBe(mine);
    await expect(
      reveal(provider('a'), context(noon, 'stdio:b'), mine),
    ).resolves.toBeUndefined();
    await expect(
      reveal(provider('a'), context(noon, 'stdio:a'), yours),
    ).resolves.toBeUndefined();
  });

  it('gives another tenant another pseudonym, which it alone opens', async () => {
    const here = await hide(provider('a'), context(noon), 7);
    const there = await hide(
      provider('a'),
      context(noon, 'stdio:local-stdio', 'demo-tenant'),
      7,
    );
    expect(there).not.toBe(here);
    await expect(
      reveal(
        provider('a'),
        context(noon, 'stdio:local-stdio', 'demo-tenant'),
        here,
      ),
    ).resolves.toBeUndefined();
  });

  it('gives another instance another pseudonym, though over stdio the tenant is the same', async () => {
    // Two servers over stdio for two instances, with the same key file and
    // the same subject.
    const here = await hide(provider('a'), context(noon), 7);
    const elsewhere = context(
      noon,
      'stdio:local-stdio',
      'default',
      'https://demo.example',
    );
    expect(await hide(provider('a'), elsewhere, 7)).not.toBe(here);
    await expect(
      reveal(provider('a'), elsewhere, here),
    ).resolves.toBeUndefined();
  });

  it('gives another pseudonym on another day, and takes one back on the next day only', async () => {
    const today = await hide(provider('a'), context(noon), 7);
    const tomorrow = await hide(provider('a'), context(noon + dayMs), 7);
    expect(tomorrow).not.toBe(today);
    await expect(
      reveal(provider('a'), context(noon + dayMs), today),
    ).resolves.toBe(7);
    await expect(
      reveal(provider('a'), context(noon + 2 * dayMs), today),
    ).resolves.toBeUndefined();
    await expect(
      reveal(provider('a'), context(noon - dayMs), today),
    ).resolves.toBeUndefined();
  });

  it('changes the pseudonym at midnight UTC and takes the old one back after it', async () => {
    const midnight = Date.UTC(2026, 10, 1);
    const before = await hide(provider('a'), context(midnight - 1), 7);
    const after = await hide(provider('a'), context(midnight), 7);
    expect(after).not.toBe(before);
    await expect(
      reveal(provider('a'), context(midnight), before),
    ).resolves.toBe(7);
  });

  it('keeps the pseudonyms of the day before a change of the key reversible', async () => {
    const before = await hide(provider('old'), context(noon), 7);
    const sameDay = await hide(provider('old'), context(noon + hourMs), 7);
    // After the change, the new key is in ECCLIUM_PSEUDONYM_KEY_FILE and
    // the old one in ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE: a pseudonym made
    // an hour before the change opens later that day, and one of the day
    // before opens the next day.
    await expect(reveal(changed, context(noon + dayMs), before)).resolves.toBe(
      7,
    );
    await expect(
      reveal(changed, context(noon + 2 * hourMs), sameDay),
    ).resolves.toBe(7);
    // New pseudonyms come only from the new key.
    await expect(hide(changed, context(noon + dayMs), 7)).resolves.toBe(
      await hide(provider('new'), context(noon + dayMs), 7),
    );
    // Without the old key, the pseudonym of the day before is lost.
    await expect(
      reveal(provider('new'), context(noon + dayMs), before),
    ).resolves.toBeUndefined();
  });

  it('refuses a pseudonym with any one sign changed', async () => {
    const pseudonym = await hide(provider('a'), context(noon), 7);
    const refused = await during(provider('a'), context(noon), (pseudonyms) => {
      const opened: (number | undefined)[] = [];
      for (
        let index = pseudonymPrefix.length;
        index < pseudonym.length;
        index += 1
      ) {
        for (const sign of alphabet) {
          if (sign === pseudonym.charAt(index)) continue;
          opened.push(
            pseudonyms.reveal(
              `${pseudonym.slice(0, index)}${sign}${pseudonym.slice(index + 1)}`,
            ),
          );
        }
      }
      return opened;
    });
    expect(refused).toHaveLength(39 * 31);
    expect(refused.every((id) => id === undefined)).toBe(true);
  });

  it('refuses the other spellings of the same bytes in the last sign', async () => {
    const pseudonym = await hide(provider('a'), context(noon), 7);
    const last = alphabet.indexOf(pseudonym.charAt(pseudonym.length - 1));
    // The last sign carries two bits of the bytes and three that must be
    // zero. Each other value of those three bits gives the same bytes.
    const others = [1, 2, 3, 4, 5, 6, 7].map(
      (low) => `${pseudonym.slice(0, -1)}${alphabet.charAt(last | low)}`,
    );
    expect(last & 0b111).toBe(0);
    for (const other of others) {
      await expect(
        reveal(provider('a'), context(noon), other),
      ).resolves.toBeUndefined();
    }
  });

  it('writes the sealed ID as Base32 and refuses a number past 2^53 - 1 sealed with the right key', async () => {
    const ctx = context(noon);
    const [key = new Uint8Array()] = await provider('a').dataKeys(
      ctx,
      'pseudonym',
      '2026-10-31' as IsoDate,
    );
    const seal = (plaintext: Uint8Array): Uint8Array =>
      sealGcmSiv(
        key,
        new Uint8Array(12),
        new TextEncoder().encode('ecclium/pseudonym/v1/personId'),
        plaintext,
      );
    // Base32 in lower case without padding, written out here a second
    // time, bit by bit.
    const base32 = (bytes: Uint8Array): string => {
      let bits = '';
      for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
      bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
      let text = pseudonymPrefix;
      for (let index = 0; index < bits.length; index += 5) {
        text += alphabet.charAt(
          Number.parseInt(bits.slice(index, index + 5), 2),
        );
      }
      return text;
    };
    await expect(hide(provider('a'), ctx, 7)).resolves.toBe(
      base32(seal(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 7]))),
    );
    const tooLarge = base32(seal(new Uint8Array(8).fill(0xff)));
    expect(tooLarge).toHaveLength(pseudonymLength);
    await expect(reveal(provider('a'), ctx, tooLarge)).resolves.toBeUndefined();
  });

  it.each([
    ['too short', (text: string) => text.slice(0, -1)],
    ['too long', (text: string) => `${text}a`],
    ['without the prefix', (text: string) => `p2_${text.slice(3)}`],
    ['in capitals', (text: string) => text.toUpperCase()],
    [
      'with a sign outside the alphabet',
      (text: string) => `${text.slice(0, -1)}1`,
    ],
    ['as the number of the person', () => 7],
    ['as nothing', () => undefined],
  ])('refuses a pseudonym %s', async (_name, change) => {
    const pseudonym = await hide(provider('a'), context(noon), 7);
    await expect(
      reveal(provider('a'), context(noon), change(pseudonym)),
    ).resolves.toBeUndefined();
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53, Infinity, '7'])(
    'refuses to hide %s',
    async (id) => {
      await expect(
        hide(provider('a'), context(noon), id as number),
      ).rejects.toThrow(
        new TypeError('The ID of a person is a whole number from 0.'),
      );
    },
  );

  it('copies the keys at once, erases what the provider gave, and refuses to work once erased', async () => {
    const given: Uint8Array[] = [];
    const watched: KeyProvider = {
      dataKeys: async (ctx, purpose, day) => {
        const keys = await changed.dataKeys(ctx, purpose, day);
        given.push(...keys);
        return keys;
      },
    };
    const pseudonyms = await openPseudonyms(watched, context(noon));
    expect(given).toHaveLength(4);
    expect(given.every((key) => key.every((byte) => byte === 0))).toBe(true);
    const pseudonym = pseudonyms.hide(7);
    expect(pseudonym).toBe(await hide(provider('new'), context(noon), 7));
    expect(pseudonyms.reveal(pseudonym)).toBe(7);
    pseudonyms.erase();
    expect(() => pseudonyms.hide(7)).toThrow(
      new TypeError('The keys of the call are erased.'),
    );
    expect(() => pseudonyms.reveal(pseudonym)).toThrow(
      new TypeError('The keys of the call are erased.'),
    );
    expect(Object.isFrozen(pseudonyms)).toBe(true);
  });

  it('refuses a provider that hands out the same arrays twice, once they are erased', async () => {
    let cache: readonly Uint8Array[] | undefined;
    const caching: KeyProvider = {
      dataKeys: async (ctx, purpose, day) => {
        cache ??= await provider('a').dataKeys(ctx, purpose, day);
        return cache;
      },
    };
    const first = await openPseudonyms(caching, context(noon));
    first.erase();
    await expect(openPseudonyms(caching, context(noon))).rejects.toThrow(
      new TypeError('The provider gave no key of 32 bytes.'),
    );
  });

  it('erases the keys of the day when the provider refuses the day before', async () => {
    const given: Uint8Array[] = [];
    let calls = 0;
    const failing: KeyProvider = {
      dataKeys: async (ctx, purpose, day) => {
        calls += 1;
        if (calls === 2) throw new TypeError('The day is invalid.');
        const keys = await provider('a').dataKeys(ctx, purpose, day);
        given.push(...keys);
        return keys;
      },
    };
    await expect(openPseudonyms(failing, context(noon))).rejects.toThrow(
      new TypeError('The day is invalid.'),
    );
    expect(given).toHaveLength(1);
    expect(given.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    ['no key', () => []],
    ['a key of 16 bytes', () => [new Uint8Array(16)]],
    ['a key of only zeros', () => [new Uint8Array(32)]],
    [
      'three keys',
      () => [
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        new Uint8Array(32).fill(3),
      ],
    ],
    ['no bytes', () => ['key']],
    ['no list', () => 'keys'],
  ])(
    'refuses a provider that gives %s, and erases what it gave',
    async (_name, keys) => {
      const given: unknown[] = [];
      const broken = {
        dataKeys: () => {
          const list: unknown = keys();
          if (Array.isArray(list)) given.push(...(list as unknown[]));
          return Promise.resolve(list);
        },
      } as unknown as KeyProvider;
      await expect(openPseudonyms(broken, context(noon))).rejects.toThrow(
        new TypeError('The provider gave no key of 32 bytes.'),
      );
      for (const key of given) {
        if (key instanceof Uint8Array)
          expect(key.every((byte) => byte === 0)).toBe(true);
      }
    },
  );

  it.each([
    ['no clock', { tenantId: 'default' }],
    ['a clock without a time', { clock: { now: () => Number.NaN } }],
    ['a clock that is no function', { clock: { now: 0 } }],
    ['no context', undefined],
  ])('refuses a context with %s', async (_name, ctx) => {
    await expect(
      openPseudonyms(provider('a'), ctx as unknown as TenantContext),
    ).rejects.toThrow(new TypeError('The clock of the context gives no time.'));
  });

  it('passes on a refusal of the provider', async () => {
    await expect(
      openPseudonyms(provider('a'), {
        ...context(noon),
        tenantId: 'Demo Tenant',
      } as unknown as TenantContext),
    ).rejects.toThrow(new TypeError('The tenant is invalid.'));
  });
});
