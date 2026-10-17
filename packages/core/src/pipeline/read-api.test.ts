import {
  isEccliumError,
  type Me,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { createReadAccess } from './read-api.js';

type Client = Parameters<typeof createReadAccess>[0];

const me: Me = { id: 1, firstName: 'Person', lastName: 'A', email: null };
const ctx = Object.freeze({
  instance: 'https://example.church.tools',
}) as unknown as TenantContext;

const fakeClient = () => {
  const seen: TenantContext[] = [];
  const client: Client = {
    whoami: (context) => {
      seen.push(context);
      return Promise.resolve(me);
    },
    permissions: (context) => {
      seen.push(context);
      return Promise.resolve({ kind: 'unknown' });
    },
  };
  return { client, seen };
};

describe('createReadAccess', () => {
  it('reads with the context of the call', async () => {
    const { client, seen } = fakeClient();
    const access = createReadAccess(client, ctx);
    await expect(access.read.whoami()).resolves.toBe(me);
    await expect(access.read.permissions()).resolves.toEqual({
      kind: 'unknown',
    });
    expect(seen).toEqual([ctx, ctx]);
  });

  it('is frozen and without prototype', () => {
    const access = createReadAccess(fakeClient().client, ctx);
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.read)).toBe(true);
    expect(Object.getPrototypeOf(access.read)).toBeNull();
  });

  it('rejects every method with internal after revoke, without reading', async () => {
    const { client, seen } = fakeClient();
    const access = createReadAccess(client, ctx);
    const { read } = access;
    access.revoke();
    for (const call of [read.whoami(), read.permissions()]) {
      const error: unknown = await call.catch((thrown: unknown) => thrown);
      expect(isEccliumError(error) && error.code).toBe('internal');
    }
    expect(seen).toEqual([]);
  });
});
