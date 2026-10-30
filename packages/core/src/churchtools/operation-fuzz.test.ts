import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  isEccliumError,
  type TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOperationUrl,
  findReadableOperation,
  generatedOperations,
  type PathParameter,
  type ReadableOperation,
} from './catalog/index.js';
import { keepsTemplate } from './catalog/parameters.js';
import { createChurchToolsClient } from './client.js';

// Fuzzing of the paths of the escape hatch (ADR 0067), with a generator of
// our own and a fixed seed, so that every run tries the same values and a
// failure can be repeated. For every operation the catalog allows:
// - a path value with a hostile part never gives a URL;
// - a valid path value gives a URL with exactly the origin of the client,
//   the fixed part of the template and the filled template as its path;
// - a value of the query, hostile or not, never changes origin or path;
// - and through the client, a refused value never reaches the transport
//   and takes no place of the throttle.

/** xorshift32: small, fast and the same on every platform. */
const generator = (seed: number) => {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const below = (limit: number): number => next() % limit;
  const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T;
  return { next, below, pick };
};

const random = generator(0x0067);

// Parts that must never reach a path: dot segments in every encoding,
// slashes and backslashes, the start of a query or a fragment, control
// and hidden characters, forms that NFKC turns into a dot or a slash, and
// addresses. Each holds a character no kind of path value has, so a text
// with one of them is never valid, whatever stands around it.
const hostileParts: readonly string[] = [
  '..',
  '../',
  '..\\',
  '%2e%2e',
  '%2E%2E%2F',
  '%252e%252e%252f',
  '%2f',
  '%5c',
  '%00',
  '/',
  '\\',
  '?',
  '#',
  '?x=1',
  '#top',
  String.fromCodePoint(0),
  '\n',
  '\r',
  '\t',
  String.fromCodePoint(0x7f),
  String.fromCodePoint(0x85),
  String.fromCodePoint(0xff0e, 0xff0e, 0xff0f),
  String.fromCodePoint(0x2024),
  String.fromCodePoint(0x2215),
  String.fromCodePoint(0x0301),
  String.fromCodePoint(0x202e),
  String.fromCodePoint(0x200b),
  String.fromCodePoint(0xd800),
  ' ',
  ';',
  '&',
  '=',
  '@',
  'https://other.example',
  '//other.example',
];

// Whole values that look like a number or a valid text but are none: next
// to another part they could become valid, so they stand alone.
const hostileWholes: readonly string[] = [
  '',
  '0',
  '-1',
  '+1',
  '1e3',
  '0x1',
  '01',
  '1.0',
  '9007199254740993',
  'Group',
  'GROUP',
  '2026-02-30',
  '2026-10-30T00:00:00Z',
  '00000000-0000-4000-8000-00000000000g',
  'x'.repeat(5_000),
];

const validPrefixes: readonly string[] = ['', '1', '12', 'group', '2026-10-30'];

// A text with at least one hostile part, sometimes around a valid start.
const hostileText = (): string => {
  const parts = [random.pick(validPrefixes)];
  const count = 1 + random.below(3);
  for (let index = 0; index < count; index += 1) {
    parts.push(random.pick(hostileParts));
  }
  if (random.below(2) === 0) parts.push(random.pick(validPrefixes));
  return parts.join('');
};

// Values of other types a tool could pass.
const hostileValues: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2 ** 53,
  true,
  null,
  undefined,
  [],
  [1],
  {},
  { toString: () => '1' },
];

const hex = '0123456789abcdef';
const guid = (): string => {
  const part = (length: number) =>
    Array.from({ length }, () => hex.charAt(random.below(hex.length))).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`;
};

const day = (): string => {
  const time = Date.UTC(1990, 0, 1) + random.below(20_000) * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
};

const validValue = (parameter: PathParameter): string | number => {
  switch (parameter.kind) {
    case 'integer':
      return random.below(2) === 0
        ? 1 + random.below(1_000_000)
        : String(1 + random.next());
    case 'guid':
      return guid();
    case 'date':
      return day();
    case 'enum':
      return random.pick(parameter.values ?? []);
  }
};

const readable: readonly ReadableOperation[] = generatedOperations.flatMap(
  (operation) => {
    const found = findReadableOperation(operation.operationId);
    return found.ok ? [found.operation] : [];
  },
);

// A valid value for every required parameter of the query.
const validQuery = (operation: ReadableOperation): Record<string, unknown> =>
  Object.fromEntries(
    operation.queryParameters
      .filter((parameter) => parameter.required)
      .map((parameter) => {
        const one = ((): unknown => {
          switch (parameter.kind) {
            case 'boolean':
              return true;
            case 'string':
              return 'x';
            case 'date':
            case 'date-or-date-time':
              return day();
            case 'date-time':
              return '2026-10-30T12:00:00Z';
            case 'enum':
              return parameter.values?.[0];
            default:
              return 1;
          }
        })();
        return [parameter.name, parameter.list === true ? [one] : one];
      }),
  );

const validPath = (
  operation: ReadableOperation,
): Record<string, string | number> =>
  Object.fromEntries(
    operation.pathParameters.map((parameter) => [
      parameter.name,
      validValue(parameter),
    ]),
  );

const origin = doubleOrigin;

describe('fuzzing of the paths of the escape hatch', () => {
  it('has operations with path parameters of every kind to fuzz', () => {
    const kinds = new Set(
      readable.flatMap((operation) =>
        operation.pathParameters.map((parameter) => parameter.kind),
      ),
    );
    expect([...kinds].sort()).toEqual(['date', 'enum', 'guid', 'integer']);
  });

  it('never builds a URL from a path value with a hostile part', () => {
    let tried = 0;
    for (const operation of readable) {
      for (const parameter of operation.pathParameters) {
        const values: unknown[] = [...hostileValues, ...hostileWholes];
        for (let index = 0; index < 60; index += 1) values.push(hostileText());
        for (const value of values) {
          const path = { ...validPath(operation), [parameter.name]: value };
          const built = buildOperationUrl(origin, operation, {
            path,
            query: validQuery(operation),
          });
          expect(built.ok, `${operation.operationId} ${parameter.name}`).toBe(
            false,
          );
          tried += 1;
        }
      }
    }
    expect(tried).toBeGreaterThan(5_000);
  });

  it('keeps origin, fixed part and template for every valid path value', () => {
    for (const operation of readable) {
      for (let round = 0; round < 20; round += 1) {
        const path = validPath(operation);
        const built = buildOperationUrl(origin, operation, {
          path,
          query: validQuery(operation),
        });
        if (!built.ok) throw new Error(built.message);
        let expected = operation.path;
        for (const [name, value] of Object.entries(path)) {
          expected = expected.replace(`{${name}}`, String(value));
        }
        expect(built.url.origin).toBe(origin);
        expect(built.url.pathname).toBe(expected);
        expect([...built.url.searchParams.keys()].sort()).toEqual(
          [...new Set(Object.keys(validQuery(operation)))].sort(),
        );
        expect(keepsTemplate(built.url, origin, operation.path)).toBe(true);
      }
    }
  });

  it('never lets a value of the query change origin or path', () => {
    const texts = readable.flatMap((operation) =>
      operation.queryParameters
        .filter(
          (parameter) => parameter.kind === 'string' && parameter.list !== true,
        )
        .map((parameter) => ({ operation, name: parameter.name })),
    );
    expect(texts.length).toBeGreaterThan(10);
    for (const { operation, name } of texts) {
      const path = validPath(operation);
      const required = validQuery(operation);
      const plain = buildOperationUrl(origin, operation, {
        path,
        query: required,
      });
      if (!plain.ok) throw new Error(plain.message);
      for (let round = 0; round < 40; round += 1) {
        const value = hostileText();
        const built = buildOperationUrl(origin, operation, {
          path,
          query: { ...required, [name]: value },
        });
        if (!built.ok) continue;
        expect(built.url.origin).toBe(origin);
        expect(built.url.pathname).toBe(plain.url.pathname);
        expect(built.url.hash).toBe('');
        expect(built.url.searchParams.getAll(name)).toEqual([value]);
      }
      // Characters of a URL in a text of the query stay inside its value.
      const value = '../?#&=%2e/\\@other.example';
      const built = buildOperationUrl(origin, operation, {
        path,
        query: { ...required, [name]: value },
      });
      expect(built.ok && built.url.searchParams.getAll(name)).toEqual([value]);
      expect(built.ok && built.url.pathname).toBe(plain.url.pathname);
    }
  });
});

describe('fuzzing through the client', () => {
  const open: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((item) => item.close()));
  });

  it('sends nothing and takes no place of the throttle for a refused value', async () => {
    const loaded = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: origin,
        ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
      },
      transport: 'stdio',
    });
    if (!loaded.ok) throw new Error('the configuration of the test is invalid');
    const double = createChurchToolsDouble({
      token: loaded.config.churchtoolsToken,
    });
    open.push(double);
    const clock = Object.freeze({ now: (): number => 0 });
    const client = createChurchToolsClient({
      transport: double.transport,
      origin,
      requestsPerMinute: 1,
      clock,
    });
    const ctx = Object.freeze({
      instance: origin,
      signal: new AbortController().signal,
      log: Object.freeze({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
      clock,
    }) as unknown as TenantContext;
    const withPath = readable.filter(
      (operation) => operation.pathParameters.length > 0,
    );
    for (let round = 0; round < 300; round += 1) {
      const operation = random.pick(withPath);
      const parameter = random.pick(operation.pathParameters);
      try {
        await client.operation(ctx, {
          operationId: operation.operationId,
          path: { ...validPath(operation), [parameter.name]: hostileText() },
          query: validQuery(operation),
        });
        throw new Error('expected a refusal');
      } catch (error) {
        expect(isEccliumError(error) && error.code).toBe('validation');
      }
    }
    expect(double.calls()).toHaveLength(0);
    // The one place of the throttle is still free.
    double
      .intercept({ path: '/api/whoami', method: 'GET' })
      .reply(
        200,
        { data: {} },
        { headers: { 'content-type': 'application/json' } },
      );
    await client.operation(ctx, { operationId: 'get-whoami' });
    expect(double.calls()).toHaveLength(1);
  });
});
