import { createHash, hkdfSync } from 'node:crypto';

import type {
  ActorKind,
  IsoDate,
  KeyPurpose,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from './file-provider.js';
import { KeyMaterial } from './key-material.js';

// The secrets are made from a seed instead of written out, so that no
// secret scanner reads a test secret as a leaked one.
const hexOf = (seed: string): string =>
  createHash('sha256').update(seed).digest('hex');
const secret = (seed: string): KeyMaterial => new KeyMaterial(hexOf(seed));

const day = '2026-10-31' as IsoDate;
const instance = 'https://example.church.tools';

// The parts of a context a provider reads.
const contextOf = (
  tenantId: string,
  kind: ActorKind,
  id: string,
  origin = instance,
): TenantContext =>
  Object.freeze({
    tenantId,
    instance: origin,
    actor: Object.freeze({ kind, id }),
  }) as unknown as TenantContext;

const ctx = contextOf('default', 'user', 'stdio:local-stdio');

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// The derivation as ADR 0069 states it, written out here a second time:
// HKDF with SHA-256, an empty salt and as info each part after its length
// in two bytes, big-endian.
const expected = (seed: string, parts: readonly string[]): string => {
  const info = Buffer.concat(
    parts.flatMap((part) => {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(2);
      length.writeUInt16BE(bytes.length);
      return [length, bytes];
    }),
  );
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(hexOf(seed), 'hex'),
      Buffer.alloc(0),
      info,
      32,
    ),
  ).toString('hex');
};

describe('createFileKeyProvider', () => {
  it('derives the key of a tenant, an actor and a day as ADR 0069 states', async () => {
    const keys = await createFileKeyProvider({ current: secret('a') }).dataKeys(
      ctx,
      'pseudonym',
      day,
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).toHaveLength(32);
    expect(hex(keys[0] ?? new Uint8Array())).toBe(
      expected('a', [
        'ecclium/key/v1',
        'pseudonym',
        'default',
        'https://example.church.tools',
        'user',
        'stdio:local-stdio',
        '2026-10-31',
      ]),
    );
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it('gives the same key for the same tenant, actor and day', async () => {
    const provider = createFileKeyProvider({ current: secret('a') });
    const [first] = await provider.dataKeys(ctx, 'pseudonym', day);
    const [second] = await provider.dataKeys(ctx, 'pseudonym', day);
    expect(hex(second ?? new Uint8Array())).toBe(
      hex(first ?? new Uint8Array()),
    );
  });

  it.each([
    [
      'another tenant',
      contextOf('demo-tenant', 'user', 'stdio:local-stdio'),
      day,
    ],
    ['another actor', contextOf('default', 'user', 'stdio:other'), day],
    [
      'another kind of actor',
      contextOf('default', 'service', 'stdio:local-stdio'),
      day,
    ],
    ['another day', ctx, '2026-11-01' as IsoDate],
    [
      'another instance',
      contextOf('default', 'user', 'stdio:local-stdio', 'https://demo.example'),
      day,
    ],
  ])('gives another key for %s', async (_name, other, otherDay) => {
    const provider = createFileKeyProvider({ current: secret('a') });
    const [base] = await provider.dataKeys(ctx, 'pseudonym', day);
    const [changed] = await provider.dataKeys(other, 'pseudonym', otherDay);
    expect(hex(changed ?? new Uint8Array())).not.toBe(
      hex(base ?? new Uint8Array()),
    );
  });

  it('gives another key for another secret', async () => {
    const [first] = await createFileKeyProvider({
      current: secret('a'),
    }).dataKeys(ctx, 'pseudonym', day);
    const [second] = await createFileKeyProvider({
      current: secret('b'),
    }).dataKeys(ctx, 'pseudonym', day);
    expect(hex(second ?? new Uint8Array())).not.toBe(
      hex(first ?? new Uint8Array()),
    );
  });

  it('gives the key of the previous secret second while it changes', async () => {
    const [current] = await createFileKeyProvider({
      current: secret('new'),
    }).dataKeys(ctx, 'pseudonym', day);
    const [previous] = await createFileKeyProvider({
      current: secret('old'),
    }).dataKeys(ctx, 'pseudonym', day);
    const both = await createFileKeyProvider({
      current: secret('new'),
      previous: secret('old'),
    }).dataKeys(ctx, 'pseudonym', day);
    expect(both.map(hex)).toEqual([
      hex(current ?? new Uint8Array()),
      hex(previous ?? new Uint8Array()),
    ]);
  });

  it('gives fresh copies that the caller may erase', async () => {
    const provider = createFileKeyProvider({ current: secret('a') });
    const [first] = await provider.dataKeys(ctx, 'pseudonym', day);
    const before = hex(first ?? new Uint8Array());
    first?.fill(0);
    const [second] = await provider.dataKeys(ctx, 'pseudonym', day);
    expect(hex(second ?? new Uint8Array())).toBe(before);
  });

  it.each([
    [
      'a tenant the audit refuses',
      contextOf('Demo Tenant', 'user', 'stdio:a'),
      'pseudonym',
      day,
      'The tenant is invalid.',
    ],
    [
      'an unknown kind of actor',
      contextOf('default', 'robot' as 'user', 'stdio:a'),
      'pseudonym',
      day,
      'The actor is invalid.',
    ],
    [
      'an actor without an ID',
      contextOf('default', 'user', ''),
      'pseudonym',
      day,
      'The actor is invalid.',
    ],
    [
      'an instance that is no checked origin',
      contextOf('default', 'user', 'stdio:a', 'https://Demo.example/'),
      'pseudonym',
      day,
      'The instance is invalid.',
    ],
    [
      'an instance that is no string',
      contextOf(
        'default',
        'user',
        'stdio:a',
        new URL(instance) as unknown as string,
      ),
      'pseudonym',
      day,
      'The instance is invalid.',
    ],
    ['an unknown purpose', ctx, 'snapshot', day, 'The purpose is unknown.'],
    [
      'a day that does not exist',
      ctx,
      'pseudonym',
      '2026-02-30',
      'The day is invalid.',
    ],
    ['no context', undefined, 'pseudonym', day, 'The tenant is invalid.'],
  ])('refuses %s', async (_name, context, purpose, when, message) => {
    const provider = createFileKeyProvider({ current: secret('a') });
    await expect(
      provider.dataKeys(
        context as typeof ctx,
        purpose as KeyPurpose,
        when as IsoDate,
      ),
    ).rejects.toThrow(new TypeError(message));
  });

  it('reads tenant and actor only as own data, never through a getter', async () => {
    const provider = createFileKeyProvider({ current: secret('a') });
    const sneaky = Object.defineProperty(
      { instance, actor: { kind: 'user', id: 'stdio:a' } },
      'tenantId',
      {
        get: () => 'default',
      },
    );
    await expect(
      provider.dataKeys(sneaky as unknown as typeof ctx, 'pseudonym', day),
    ).rejects.toThrow(new TypeError('The tenant is invalid.'));
    await expect(
      provider.dataKeys(new Proxy(ctx, {}), 'pseudonym', day),
    ).rejects.toThrow(new TypeError('The tenant is invalid.'));
  });

  it.each([
    [
      'a current key that is no key',
      { current: hexOf('a') },
      'The current key is no key.',
    ],
    [
      'a previous key that is no key',
      { current: secret('a'), previous: hexOf('b') },
      'The previous key is no key.',
    ],
    [
      'the same key twice',
      { current: secret('a'), previous: secret('a') },
      'The previous key is the current one.',
    ],
    ['no keys', undefined, 'The current key is no key.'],
  ])('refuses %s', (_name, keys, message) => {
    expect(() =>
      createFileKeyProvider(keys as unknown as { current: KeyMaterial }),
    ).toThrow(new TypeError(message));
  });

  it('is frozen and holds no secret in a property', () => {
    const provider = createFileKeyProvider({ current: secret('a') });
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.keys(provider)).toEqual(['dataKeys']);
    expect(JSON.stringify(provider)).toBe('{}');
  });
});
