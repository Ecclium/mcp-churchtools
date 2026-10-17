import type { Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createMockedHttpTransport } from './compose-mock.js';
import { Secret } from './secret.js';

// The factory of the transport on a MockAgent, without the double of
// testkit around it. Hosts lie under .example (RFC 2606); the token is a
// canary made at run time.

const origin = 'https://demo.example';
const canary = makeCanary('token');
const token = new Secret(canary.value);
const userAgent = 'Ecclium/0.0.0-test';
const logger: Logger = Object.freeze({
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
});
const clock = Object.freeze({ now: (): number => 0 });

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('createMockedHttpTransport', () => {
  it('answers from interceptors and reports each call, frozen', async () => {
    const mocked = createMockedHttpTransport({
      origin,
      token,
      userAgent,
      logger,
      clock,
    });
    open.push(mocked);
    mocked
      .intercept({ path: '/api/persons?page=1', method: 'GET' })
      .reply(200, '{}');
    const answer = await mocked.transport.get(
      new URL(`${origin}/api/persons?page=1`),
      { maxResponseBytes: 64 },
    );
    expect(answer.status).toBe(200);
    mocked.assertNoPendingInterceptors();
    const calls = mocked.calls();
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/api/persons',
        searchParams: { page: '1' },
        headers: {
          authorization: `Login ${canary.value}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
          'user-agent': userAgent,
        },
      },
    ]);
    expect(Object.isFrozen(calls)).toBe(true);
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(Object.isFrozen(calls[0]?.headers)).toBe(true);
    expect(Object.getPrototypeOf(calls[0]?.searchParams)).toBeNull();
  });

  it('connects nowhere for a request without an interceptor', async () => {
    const mocked = createMockedHttpTransport({
      origin,
      token,
      userAgent,
      logger,
      clock,
    });
    open.push(mocked);
    await expect(
      mocked.transport.get(new URL(`${origin}/api`), { maxResponseBytes: 64 }),
    ).rejects.toMatchObject({ category: 'failed' });
  });

  it('refuses an origin that is not canonical, a token that is no Secret and a User-Agent that is not printable', () => {
    expect(() =>
      createMockedHttpTransport({
        origin: `${origin}/`,
        token,
        userAgent,
        logger,
        clock,
      }),
    ).toThrow('The origin of a transport must be canonical.');
    expect(() =>
      createMockedHttpTransport({
        origin,
        token: { value: canary.value } as unknown as Secret,
        userAgent,
        logger,
        clock,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createMockedHttpTransport({
        origin,
        token,
        userAgent: 'Ecclium\nx',
        logger,
        clock,
      }),
    ).toThrow('The User-Agent of a transport must be printable.');
  });
});
