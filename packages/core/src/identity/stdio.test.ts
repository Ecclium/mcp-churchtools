import { inspect } from 'node:util';

import type { Identity } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it, vi } from 'vitest';

import { auditFieldSchemas, auditPlaceholders } from '../audit/index.js';
import { defaultStdioSubject, loadConfig } from '../config/index.js';
import { createStdioIdentity, createStdioTenantResolver } from './stdio.js';

const subjectError = 'The stdio subject is invalid.';

const identityOf = (subject: string): Identity =>
  createStdioIdentity({ stdioSubject: subject, readOnly: true });

describe('createStdioIdentity', () => {
  it('takes the default subject of the configuration', () => {
    const result = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: 'https://example.church.tools',
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: '/path/to/token-file',
      },
      transport: 'stdio',
      tokenFiles: {
        openSync: () => 3,
        fstatSync: () => ({ isFile: () => true, uid: 1, mode: 0o600, size: 4 }),
        readSync: (_fd, buffer, offset) => {
          if (offset > 0) return 0;
          buffer.set([0x61, 0x62, 0x63, 0x0a], offset);
          return 4;
        },
        closeSync: () => undefined,
        getuid: () => 1,
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
      },
    });
    if (!result.ok) throw new Error('the configuration did not load');
    expect(createStdioIdentity(result.config)).toEqual({
      source: 'stdio',
      subject: defaultStdioSubject,
      scopes: ['read'],
    });
    expect(defaultStdioSubject).toBe('local-stdio');
  });

  it('is frozen, without a prototype, with exactly three keys', () => {
    const identity = identityOf('local-stdio');
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.scopes)).toBe(true);
    expect(Object.getPrototypeOf(identity)).toBeNull();
    expect(Reflect.ownKeys(identity)).toEqual(['source', 'subject', 'scopes']);
  });

  it('gives write only when read-only is false', () => {
    expect(
      createStdioIdentity({ stdioSubject: 'local-stdio', readOnly: true })
        .scopes,
    ).toEqual(['read']);
    expect(
      createStdioIdentity({ stdioSubject: 'local-stdio', readOnly: false })
        .scopes,
    ).toEqual(['read', 'write']);
  });

  it.each(['false', 'true', 0, 1, undefined, Object(false) as object])(
    'refuses the read-only flag %j and never grants write',
    (readOnly) => {
      expect(() =>
        createStdioIdentity({
          stdioSubject: 'local-stdio',
          readOnly: readOnly as unknown as boolean,
        }),
      ).toThrow('The read-only flag is not a boolean.');
    },
  );

  it.each(['a', 'a-', 'a'.repeat(32), 'local-operator-2'])(
    'accepts the subject %j',
    (subject) => {
      expect(identityOf(subject).subject).toBe(subject);
    },
  );

  // A name written as a slug fits; ADR 0055 records this as a residual
  // risk. The test pins the limit, so that changing it is deliberate.
  it('accepts a name written as a slug, the known limit of the pattern', () => {
    expect(identityOf('max-mustermann').subject).toBe('max-mustermann');
  });

  it.each([
    'a'.repeat(33),
    '',
    '1abc',
    '-a',
    'max.mustermann@example.org',
    'max.mustermann',
    'Max',
    'max mustermann',
    'max_mustermann',
    'm\u00fcller',
    '\u217cocal-stdio',
    'local\u2010stdio',
    'local-stdio\n',
    'local-stdio\0',
    ' local-stdio',
    'invalid',
  ])('refuses the subject %j', (subject) => {
    expect(() => identityOf(subject)).toThrow(subjectError);
  });

  it('reads its input once, as own data, never through a getter', () => {
    const getter = vi.fn(() => 'local-stdio');
    const withGetter = Object.defineProperty(
      { readOnly: true },
      'stdioSubject',
      {
        get: getter,
        enumerable: true,
      },
    ) as { stdioSubject: string; readOnly: boolean };
    expect(() => createStdioIdentity(withGetter)).toThrow(subjectError);
    expect(getter).not.toHaveBeenCalled();
    const inherited = Object.assign(
      Object.create({ stdioSubject: 'local-stdio' }) as object,
      { readOnly: true },
    ) as { stdioSubject: string; readOnly: boolean };
    expect(() => createStdioIdentity(inherited)).toThrow(subjectError);
    const trap = vi.fn();
    expect(() =>
      createStdioIdentity(
        new Proxy<{ stdioSubject: string; readOnly: boolean }>(
          { stdioSubject: 'local-stdio', readOnly: true },
          { get: trap, getOwnPropertyDescriptor: trap },
        ),
      ),
    ).toThrow(subjectError);
    expect(trap).not.toHaveBeenCalled();
  });

  it('keeps a value out of its message', () => {
    const canary = makeCanary('name').value;
    const error = (() => {
      try {
        identityOf(canary);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(subjectError);
    expect(inspect(error)).not.toContain(canary);
  });
});

describe('createStdioTenantResolver', () => {
  const resolver = createStdioTenantResolver();

  it('gives the tenant default and the actor stdio:<subject> of kind user', async () => {
    const assignment = await resolver.resolve(identityOf('local-stdio'));
    expect(assignment?.tenantId).toBe('default');
    expect(assignment?.actor.kind).toBe('user');
    expect(assignment?.actor.id).toBe('stdio:local-stdio');
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(Object.isFrozen(assignment?.actor)).toBe(true);
    expect(Object.getPrototypeOf(assignment)).toBeNull();
    expect(Object.getPrototypeOf(assignment?.actor)).toBeNull();
  });

  it.each(['abc', 'a'.repeat(32)])(
    'derives an actor the audit accepts for the subject %j',
    async (subject) => {
      const assignment = await resolver.resolve(identityOf(subject));
      expect(assignment?.actor.id).toBe(`stdio:${subject}`);
      expect(
        auditFieldSchemas.actorId.safeParse(assignment?.actor.id).success,
      ).toBe(true);
      expect(auditFieldSchemas.actorKind.safeParse('user').success).toBe(true);
    },
  );

  // The pair of placeholders of the audit is { service, invalid }, so an
  // actor over stdio can never be taken for it.
  it('never gives the placeholder actor of the audit', async () => {
    const assignment = await resolver.resolve(identityOf('local-stdio'));
    expect(assignment?.actor.id).not.toBe(auditPlaceholders.actor.id);
    expect(assignment?.actor.kind).not.toBe(auditPlaceholders.actor.kind);
  });

  it('never takes the tenant or the actor from the identity', async () => {
    const identity = {
      ...identityOf('local-stdio'),
      tenantId: 'evil-tenant',
      actor: { kind: 'operator', id: 'stdio:evil' },
      instance: 'https://evil.example',
    } as Identity;
    expect(await resolver.resolve(identity)).toEqual({
      tenantId: 'default',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
    });
  });

  it('gives the same assignment whatever the scopes', async () => {
    const results = await Promise.all(
      [['read'], ['read', 'write'], [], ['admin']].map((scopes) =>
        resolver.resolve({
          source: 'stdio',
          subject: 'local-stdio',
          scopes,
        } as Identity),
      ),
    );
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it.each(['bearer', 'oauth', 'STDIO', undefined])(
    'gives nothing for the source %j',
    async (source) => {
      expect(
        await resolver.resolve({
          source,
          subject: 'local-stdio',
          scopes: [],
        } as unknown as Identity),
      ).toBeUndefined();
    },
  );

  it('never rejects and runs no getter or trap', async () => {
    const counter = vi.fn(() => 'stdio');
    const trap = vi.fn();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const inputs: unknown[] = [
      new Proxy(
        { source: 'stdio', subject: 'local-stdio', scopes: [] },
        { get: trap, getOwnPropertyDescriptor: trap },
      ),
      proxy,
      Object.defineProperty({ subject: 'local-stdio' }, 'source', {
        get: counter,
      }),
      null,
      undefined,
      'stdio:local-stdio',
      { source: 'stdio', subject: 'invalid', scopes: [] },
      { source: 'stdio', subject: 'Max', scopes: [] },
      { source: 'stdio', subject: 'a'.repeat(33), scopes: [] },
    ];
    for (const input of inputs) {
      const pending = resolver.resolve(input as Identity);
      expect(pending).toBeInstanceOf(Promise);
      expect(await pending).toBeUndefined();
    }
    expect(counter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it('is frozen and works detached from its object', async () => {
    // The point is a call apart from the object, which needs no this.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { resolve } = resolver;
    expect(await resolve(identityOf('local-stdio'))).toBeDefined();
    expect(() => {
      (resolver as { resolve: unknown }).resolve = () => undefined;
    }).toThrow(TypeError);
  });

  it('keeps no state between calls and between resolvers', async () => {
    const other = createStdioTenantResolver();
    expect(other).not.toBe(resolver);
    const results = await Promise.all([
      resolver.resolve(identityOf('a')),
      other.resolve(identityOf('b')),
      resolver.resolve(identityOf('b')),
      other.resolve(identityOf('a')),
    ]);
    expect(results.map((result) => result?.actor.id)).toEqual([
      'stdio:a',
      'stdio:b',
      'stdio:b',
      'stdio:a',
    ]);
  });
});
