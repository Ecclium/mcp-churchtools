import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { appendIds, appendPage } from './query.js';
import {
  countedMetaSchema,
  pagedMetaSchema,
  paginationSchema,
} from './schemas.js';

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

const query = (fill: (params: URLSearchParams) => void): string => {
  const params = new URLSearchParams();
  fill(params);
  return params.toString();
};

describe('appendPage', () => {
  it('sets page and limit, both always', () => {
    expect(
      query((p) => {
        appendPage(p, 1, 50);
      }),
    ).toBe('page=1&limit=50');
    expect(
      query((p) => {
        appendPage(p, 3, 100);
      }),
    ).toBe('page=3&limit=100');
  });

  it.each([
    [0, 50],
    [1, 0],
    [1, 101],
    [1.5, 50],
    [1, 1.5],
    [-0, 50],
    [Number.NaN, 50],
    [2 ** 53, 50],
    ['1' as unknown as number, 50],
  ])('refuses page %j with limit %j', (page, limit) => {
    expect(() =>
      query((p) => {
        appendPage(p, page, limit);
      }),
    ).toThrow(TypeError);
  });
});

describe('appendIds', () => {
  it('appends each ID on its own, in order', () => {
    expect(
      query((p) => {
        appendIds(p, 'ids[]', [1, 2]);
      }),
    ).toBe('ids%5B%5D=1&ids%5B%5D=2');
  });

  it.each([
    [[]],
    [Array.from({ length: 101 }, (_, i) => i + 1)],
    [[0]],
    [[1, -1]],
    [[1.5]],
    [[2 ** 53]],
    [['1' as unknown as number]],
    ['1,2' as unknown as number[]],
  ])('refuses %j', (ids) => {
    expect(() =>
      query((p) => {
        appendIds(p, 'ids[]', ids);
      }),
    ).toThrow(TypeError);
  });

  it('takes 100 IDs', () => {
    expect(() =>
      query((p) => {
        appendIds(
          p,
          'ids[]',
          Array.from({ length: 100 }, (_, i) => i + 1),
        );
      }),
    ).not.toThrow();
  });

  // The interceptor matches the exact query string. calls().searchParams
  // folds repeated names to their last value, so it cannot show them; and
  // MockAgent sorts by name, so only toString() above shows the order of
  // different names.
  it('reaches the double as ids[] in order, which the transport takes', async () => {
    const double = createChurchToolsDouble({ token });
    open.push(double);
    double
      .intercept({ path: '/api/groups?ids%5B%5D=1&ids%5B%5D=2', method: 'GET' })
      .reply(200, '{}');
    const url = new URL(`${doubleOrigin}/api/groups`);
    appendIds(url.searchParams, 'ids[]', [1, 2]);
    expect(
      (await double.transport.get(url, { maxResponseBytes: 64 })).status,
    ).toBe(200);
    double.assertNoPendingInterceptors();
  });

  it.each([[[2, 1]], [[1]]])(
    'does not match a different list %j',
    async (ids) => {
      const double = createChurchToolsDouble({ token });
      open.push(double);
      double
        .intercept({
          path: '/api/groups?ids%5B%5D=1&ids%5B%5D=2',
          method: 'GET',
        })
        .reply(200, '{}');
      const url = new URL(`${doubleOrigin}/api/groups`);
      appendIds(url.searchParams, 'ids[]', ids);
      await expect(
        double.transport.get(url, { maxResponseBytes: 64 }),
      ).rejects.toMatchObject({ category: 'failed' });
    },
  );

  it('builds names the transport takes', async () => {
    const double = createChurchToolsDouble({ token });
    open.push(double);
    double
      .intercept({ path: '/api/persons?page=1&limit=50', method: 'GET' })
      .reply(200, '{}');
    const url = new URL(`${doubleOrigin}/api/persons`);
    appendPage(url.searchParams, 1, 50);
    expect(
      (await double.transport.get(url, { maxResponseBytes: 64 })).status,
    ).toBe(200);
  });
});

describe('the schemas of meta', () => {
  const pagination = { total: 2, limit: 50, current: 1, lastPage: 1 };

  it('read pagination with and without meta.all beside it', () => {
    expect(pagedMetaSchema.parse({ pagination, count: 2 })).toEqual({
      pagination,
    });
    expect(pagedMetaSchema.parse({ pagination, count: 2, all: 5 })).toEqual({
      pagination,
    });
  });

  it('read pagination of an answer without hits', () => {
    expect(
      paginationSchema.parse({ total: 0, limit: 50, current: 1, lastPage: 0 }),
    ).toEqual({
      total: 0,
      limit: 50,
      current: 1,
      lastPage: 0,
    });
  });

  it('refuse counts that are no whole numbers or negative', () => {
    for (const total of [-1, 1.5, '2', null, 2 ** 53]) {
      expect(paginationSchema.safeParse({ ...pagination, total }).success).toBe(
        false,
      );
    }
    expect(countedMetaSchema.parse({ count: 3 })).toEqual({ count: 3 });
    expect(countedMetaSchema.safeParse({ count: -1 }).success).toBe(false);
  });
});
