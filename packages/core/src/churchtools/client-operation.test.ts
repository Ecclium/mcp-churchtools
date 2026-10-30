import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type LogFields,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createChurchToolsClient } from './client.js';
import { operationLimits, tooLargeAnswer } from './operation.js';

// Reading one operation of the escape hatch by its operationId (ADR 0067).
// Every request goes through the real transport on the ChurchTools double,
// which answers from interceptors and connects nowhere. A refusal of the
// catalog or of a value ends before the tenant, the throttle and any
// request.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

interface Line {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

// A clock that stands still, so that a throttle never fills up again.
const stillClock = Object.freeze({ now: (): number => 0 });

const setup = (requestsPerMinute = 300) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const client = createChurchToolsClient({
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute,
    clock: stillClock,
  });
  const lines: Line[] = [];
  const record = (event: string, fields?: LogFields): void => {
    lines.push({ event, fields });
  };
  const ctx = (instance = doubleOrigin): TenantContext =>
    Object.freeze({
      instance,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: record,
        info: record,
        warn: record,
        error: record,
      }),
      clock: stillClock,
    }) as unknown as TenantContext;
  return { double, client, ctx, lines };
};

const json = { headers: { 'content-type': 'application/json' } };

const at = (pathname: string) => (path: string) =>
  path.split('?')[0] === pathname;

const errorOf = async (
  call: Promise<unknown>,
): Promise<{ code: string; message: string }> => {
  try {
    await call;
  } catch (error) {
    if (isEccliumError(error)) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
};

describe('ChurchToolsClient.operation', () => {
  it('reads an allowed operation with the path from its template', async () => {
    const { double, client, ctx, lines } = setup();
    const canary = makeCanary('name');
    double
      .intercept({ path: at('/api/groups/12'), method: 'GET' })
      .reply(200, { data: { id: 12, name: canary.value } }, json);
    const answer = await client.operation(ctx(), {
      operationId: 'get-groups-groupId',
      path: { groupId: 12 },
    });
    expect(answer).toEqual({
      operationId: 'get-groups-groupId',
      sensitivity: 'special',
      root: { data: { id: 12, name: canary.value } },
    });
    expect(Object.isFrozen(answer)).toBe(true);
    expect(double.calls().map((call) => call.path)).toEqual(['/api/groups/12']);
    expect(double.calls()[0]?.searchParams).toEqual({});
    expect(JSON.stringify(lines)).not.toContain(canary.value);
  });

  it('sends only the declared parameters of the query', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/wiki/pages'), method: 'GET' })
      .reply(200, { data: [] }, json);
    await client.operation(ctx(), {
      operationId: 'get-wiki-pages',
      query: { limit: 5, 'include[]': ['preview'] },
    });
    expect(double.calls()[0]?.searchParams).toEqual({
      limit: '5',
      'include[]': 'preview',
    });
  });

  it('refuses an unknown operation before any request and without a place of the throttle', async () => {
    const { double, client, ctx, lines } = setup(1);
    for (const operationId of ['post-persons', 'get-nothing', 7, undefined]) {
      expect(await errorOf(client.operation(ctx(), { operationId }))).toEqual({
        code: 'validation',
        message:
          'No GET operation with this operationId is in the catalog of Ecclium. Look the operation up first.',
      });
    }
    expect(lines.at(-1)).toEqual({
      event: 'churchtools_operation_unknown',
      fields: { code: 'validation' },
    });
    // The one place of the throttle is still free.
    double
      .intercept({ path: at('/api/whoami'), method: 'GET' })
      .reply(200, { data: {} }, json);
    await client.operation(ctx(), { operationId: 'get-whoami' });
    expect(double.calls()).toHaveLength(1);
  });

  it.each([
    ['get-persons-id-logintoken', 'Ecclium never reads tokens or secrets.'],
    ['get-csrftoken', 'Ecclium never reads the CSRF token.'],
    [
      'get-persons-personId-information',
      'Ecclium does not read files or documents.',
    ],
    ['get-finance-accounts', 'Ecclium does not read finances.'],
    ['get-logs', 'Ecclium does not read logs or histories.'],
    [
      'get-persons-id-settings',
      'Ecclium does not read the settings of the system or of persons.',
    ],
    [
      'get-persons-personId-followups',
      'Ecclium does not read data of pastoral care or health.',
    ],
    ['get-posts', 'Ecclium does not read communication between persons.'],
    [
      'get-campuses',
      'This operation lies outside the areas that Ecclium reads.',
    ],
    ['get-events-ical', 'Ecclium does not read exports.'],
    [
      'get-persons-birthdays',
      'Ecclium does not read birthdays beyond their year.',
    ],
    ['get-fields', 'Ecclium does not read deprecated operations.'],
    [
      'get-calendars-calendarId-appointments-appointmentId-ical',
      'Ecclium reads only operations that answer with JSON.',
    ],
  ])('refuses %s before any request', async (operationId, message) => {
    const { double, client, ctx, lines } = setup();
    expect(
      await errorOf(
        client.operation(ctx(), { operationId, path: { personId: 1 } }),
      ),
    ).toEqual({ code: 'policy_denied', message });
    expect(double.calls()).toHaveLength(0);
    expect(lines).toEqual([
      {
        event: 'churchtools_operation_refused',
        fields: { code: 'policy_denied' },
      },
    ]);
  });

  it('refuses a value that does not fit before the tenant and any request', async () => {
    const { double, client, ctx, lines } = setup();
    expect(
      await errorOf(
        client.operation(ctx('https://other.example'), {
          operationId: 'get-groups-groupId',
          path: { groupId: '../persons/1' },
        }),
      ),
    ).toEqual({
      code: 'validation',
      message: 'The parameter groupId has a value of the wrong form.',
    });
    expect(double.calls()).toHaveLength(0);
    expect(lines).toEqual([
      {
        event: 'churchtools_operation_input_refused',
        fields: { code: 'validation' },
      },
    ]);
  });

  it('checks the tenant after the values and before any request', async () => {
    const { double, client, ctx } = setup();
    expect(
      await errorOf(
        client.operation(ctx('https://other.example'), {
          operationId: 'get-groups-groupId',
          path: { groupId: 1 },
        }),
      ),
    ).toMatchObject({ code: 'internal' });
    expect(double.calls()).toHaveLength(0);
  });

  it('reads each part of the request once', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/groups/1'), method: 'GET' })
      .reply(200, { data: {} }, json);
    const reads = { operationId: 0, path: 0, query: 0 };
    const request = {
      get operationId() {
        reads.operationId += 1;
        return reads.operationId === 1
          ? 'get-groups-groupId'
          : 'get-persons-id-logintoken';
      },
      get path() {
        reads.path += 1;
        return reads.path === 1 ? { groupId: 1 } : { groupId: '../x' };
      },
      get query() {
        reads.query += 1;
        return reads.query === 1 ? undefined : { other: 1 };
      },
    };
    const answer = await client.operation(ctx(), request);
    expect(answer.operationId).toBe('get-groups-groupId');
    expect(reads).toEqual({ operationId: 1, path: 1, query: 1 });
    expect(double.calls().map((call) => call.path)).toEqual(['/api/groups/1']);
  });

  it('never sends a filter the classification withholds', async () => {
    const { double, client, ctx } = setup();
    expect(
      await errorOf(
        client.operation(ctx(), {
          operationId: 'get-persons',
          query: { birthday_after: '1980-05-16' },
        }),
      ),
    ).toEqual({
      code: 'validation',
      message:
        'The parameter birthday_after has a form that Ecclium does not send.',
    });
    expect(double.calls()).toHaveLength(0);
  });

  it.each([
    [401, 'get-groups-groupId', { groupId: 1 }, 'auth'],
    [403, 'get-groups-groupId', { groupId: 1 }, 'permission'],
    [404, 'get-groups-groupId', { groupId: 1 }, 'not_found'],
    [404, 'get-groups', undefined, 'upstream'],
    [500, 'get-groups', undefined, 'upstream'],
  ] as const)(
    'turns status %i of %s into its code, without the body',
    async (status, operationId, path, code) => {
      const { double, client, ctx } = setup();
      const echo = makeCanary('name');
      double
        .intercept({ path: () => true, method: 'GET' })
        .reply(status, { errors: [echo.value] }, json);
      const error = await errorOf(
        client.operation(ctx(), { operationId, path }),
      );
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(echo.value);
    },
  );

  it('turns an answer beyond the limit of bytes into upstream with a hint on limit', async () => {
    const { double, client, ctx, lines } = setup();
    const big = JSON.stringify({
      data: 'x'.repeat(operationLimits.maxResponseBytes),
    });
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, big, json);
    expect(
      await errorOf(client.operation(ctx(), { operationId: 'get-groups' })),
    ).toEqual({ code: 'upstream', message: tooLargeAnswer });
    expect(lines.at(-1)).toEqual({
      event: 'churchtools_operation_too_large',
      fields: { code: 'upstream' },
    });
  });

  it('refuses an answer with too many elements and one whose root is no object', async () => {
    const { double, client, ctx } = setup();
    const many = JSON.stringify({
      data: Array.from({ length: operationLimits.maxElements + 1 }, () => 0),
    });
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, many, json);
    expect(
      await errorOf(client.operation(ctx(), { operationId: 'get-groups' })),
    ).toMatchObject({ code: 'upstream' });
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .reply(200, '[1]', json);
    expect(
      await errorOf(client.operation(ctx(), { operationId: 'get-groups' })),
    ).toMatchObject({ code: 'upstream' });
  });

  it('passes on a failure of the network unchanged', async () => {
    const { double, client, ctx } = setup();
    double
      .intercept({ path: at('/api/groups'), method: 'GET' })
      .replyWithError(new Error('socket hang up'));
    expect(
      await errorOf(client.operation(ctx(), { operationId: 'get-groups' })),
    ).toMatchObject({ code: 'network' });
  });
});
