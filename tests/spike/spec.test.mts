import { describe, expect, it } from 'vitest';

import {
  Schemas,
  asOpenApi,
  basePath,
  findOperation,
  normalizeTemplate,
} from '../../scripts/spike/lib/spec.mts';
import { specification } from './support.mts';

const document = asOpenApi(specification);
if (document === undefined) {
  throw new Error('synthetic document is not accepted');
}
const schemas = new Schemas(document);

describe('asOpenApi', () => {
  it('accepts OpenAPI 3 and Swagger 2 documents only', () => {
    expect(asOpenApi({ openapi: '3.0.0', paths: {} })).toBeDefined();
    expect(asOpenApi({ swagger: '2.0', paths: {} })).toBeDefined();
    expect(asOpenApi({ paths: {} })).toBeUndefined();
    expect(asOpenApi({ openapi: '3.0.0' })).toBeUndefined();
    expect(asOpenApi('<html>')).toBeUndefined();
  });
});

describe('basePath', () => {
  it('takes only the path of a server URL, never its host', () => {
    expect(basePath(document)).toBe('/api');
    expect(
      basePath({ openapi: '3.0.0', paths: {}, servers: [{ url: '/api/' }] }),
    ).toBe('/api');
    expect(basePath({ swagger: '2.0', paths: {}, basePath: '/api' })).toBe(
      '/api',
    );
    expect(basePath({ openapi: '3.0.0', paths: {} })).toBe('');
  });
});

describe('findOperation', () => {
  it('finds an operation by method and template, whatever the parameter names', () => {
    expect(normalizeTemplate('/a/{id}/b/{x}/')).toBe('/a/{}/b/{}');
    expect(
      findOperation(document, 'get', '/api/wiki/categories/{}/pages/{}'),
    ).toBeDefined();
    expect(
      findOperation(document, 'patch', '/api/wiki/categories/{}/pages/{}'),
    ).toBeDefined();
    expect(
      findOperation(document, 'delete', '/api/wiki/categories/{}/pages/{}'),
    ).toBeUndefined();
    expect(findOperation(document, 'get', '/wiki/pages')).toBeUndefined();
  });
});

describe('Schemas', () => {
  it('resolves references and stops on a cycle', () => {
    const cyclic = asOpenApi({
      openapi: '3.0.0',
      paths: {},
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    });
    expect(cyclic).toBeDefined();
    if (cyclic !== undefined) {
      expect(
        new Schemas(cyclic).resolve({ $ref: '#/components/schemas/A' }),
      ).toBeUndefined();
    }
    expect(
      schemas.resolve({ $ref: '#/components/schemas/%zz' }),
    ).toBeUndefined();
    expect(
      schemas.resolve({ $ref: 'https://example.org/schema' }),
    ).toBeUndefined();
  });

  it('collects declared properties, also through allOf', () => {
    const combined = {
      allOf: [
        { $ref: '#/components/schemas/Person' },
        { properties: { extra: {} } },
      ],
    };
    expect([...schemas.properties(combined).keys()]).toEqual([
      'id',
      'firstName',
      'lastName',
      'email',
      'extra',
    ]);
  });

  it('finds response schemas by status, class and default', () => {
    const list = findOperation(document, 'get', '/api/wiki/pages');
    const page = findOperation(
      document,
      'get',
      '/api/wiki/categories/{}/pages/{}',
    );
    expect(list).toBeDefined();
    expect(page).toBeDefined();
    if (list !== undefined && page !== undefined) {
      expect(schemas.responseSchema(list, 200)).toEqual({
        $ref: '#/components/schemas/PageList',
      });
      expect(schemas.responseSchema(list, 404)).toEqual({
        $ref: '#/components/schemas/Error',
      });
      expect(schemas.responseSchema(page, 500)).toEqual({
        $ref: '#/components/schemas/Error',
      });
      expect([...schemas.queryParameters(list)]).toEqual([
        'page',
        'limit',
        'wiki_category_ids[]',
      ]);
    }
  });

  it('reads the response schema of a Swagger 2 document', () => {
    const swagger = asOpenApi({
      swagger: '2.0',
      paths: {
        '/x': { get: { responses: { '200': { schema: { type: 'string' } } } } },
      },
    });
    const operation = swagger && findOperation(swagger, 'get', '/x');
    expect(
      swagger &&
        operation &&
        new Schemas(swagger).responseSchema(operation, 200),
    ).toEqual({
      type: 'string',
    });
  });
});
