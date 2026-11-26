import type { Identity } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { auditFieldSchemas } from '../audit/index.js';
import { createBearerTenantResolver } from './bearer.js';
import { createStdioIdentity } from './stdio.js';

// The resolver of the static bearer tokens (ADR 0074): the tenant of the
// free core, the actor bearer:<name> of kind user, and nothing for any
// other identity or for an object it cannot read without running code.

const resolver = createBearerTenantResolver();
const identity = (subject: unknown, extra: object = {}): Identity =>
  ({
    source: 'bearer',
    subject,
    scopes: ['read'],
    ...extra,
  }) as unknown as Identity;

describe('createBearerTenantResolver', () => {
  it('gives the tenant default and the actor bearer:<name> of kind user', async () => {
    const assignment = await resolver.resolve(identity('claude-code-office'));
    expect(assignment).toEqual({
      tenantId: 'default',
      actor: { kind: 'user', id: 'bearer:claude-code-office' },
    });
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment?.actor)).toBe(true);
    // The audit takes the actor as it is.
    expect(
      auditFieldSchemas.actorId.safeParse(assignment?.actor.id).success,
    ).toBe(true);
  });

  it('takes the longest name a token may have', async () => {
    const name = `a${'b'.repeat(31)}`;
    await expect(resolver.resolve(identity(name))).resolves.toMatchObject({
      actor: { id: `bearer:${name}` },
    });
  });

  it('never takes the tenant or the actor from the identity', async () => {
    await expect(
      resolver.resolve(
        identity('claude-code-office', {
          tenantId: 'demo-tenant',
          actor: { kind: 'service', id: 'runner' },
        }),
      ),
    ).resolves.toEqual({
      tenantId: 'default',
      actor: { kind: 'user', id: 'bearer:claude-code-office' },
    });
  });

  it.each([
    [
      'an identity over stdio',
      createStdioIdentity({ stdioSubject: 'local-stdio', readOnly: true }),
    ],
    [
      'an identity of OAuth',
      { source: 'oauth', subject: 'person-id-1', scopes: ['read'] },
    ],
    ['an e-mail address as subject', identity('max.mustermann@example.org')],
    ['a subject in upper case', identity('Claude-Code')],
    ['a subject too long', identity(`a${'b'.repeat(32)}`)],
    ['a subject that is no string', identity(7)],
    ['a proxy', new Proxy(identity('claude-code-office'), {})],
    [
      'a subject behind a getter',
      Object.defineProperty({ source: 'bearer', scopes: ['read'] }, 'subject', {
        get: () => 'claude-code-office',
        enumerable: true,
      }),
    ],
    ['no object', 'bearer:claude-code-office'],
  ])('gives no tenant for %s', async (_name, given) => {
    await expect(resolver.resolve(given as Identity)).resolves.toBeUndefined();
  });

  it('is frozen and keeps no state', () => {
    expect(Object.isFrozen(resolver)).toBe(true);
    expect(Object.getPrototypeOf(resolver)).toBeNull();
  });
});
