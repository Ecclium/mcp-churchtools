import { describe, expect, it } from 'vitest';

import {
  Schemas,
  asOpenApi,
  basePath,
  findOperation,
  findPathItem,
  normalizeTemplate,
  type JsonObject,
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

describe('normalizeTemplate', () => {
  // A path of the document can be megabytes long. Quadratic work would take
  // minutes here, linear work takes milliseconds.
  it('normalises a hostile path in linear time', () => {
    const braces = '{'.repeat(200_000);
    const slashes = `${'/'.repeat(200_000)}a`;
    const started = performance.now();
    expect(normalizeTemplate(braces)).toBe(braces);
    expect(normalizeTemplate(slashes)).toBe(slashes);
    expect(normalizeTemplate(`/a${'/'.repeat(200_000)}`)).toBe('/a');
    expect(normalizeTemplate('///')).toBe('/');
    expect(performance.now() - started).toBeLessThan(1_000);
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
      findOperation(document, 'put', '/api/wiki/categories/{}/pages/{}'),
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
      'guid',
      'firstName',
      'lastName',
      'email',
      'birthday',
      'meta',
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

const operationOf = (
  template: string,
): {
  readonly operation: JsonObject;
  readonly pathItem: JsonObject | undefined;
} => {
  const operation = findOperation(document, 'get', template);
  if (operation === undefined) {
    throw new Error('synthetic operation missing');
  }
  return { operation, pathItem: findPathItem(document, 'get', template) };
};

describe('the details of declared parameters', () => {
  it('finds the path item of an operation, and none for another method', () => {
    expect(findPathItem(document, 'get', '/api/groups/{}')).toHaveProperty(
      'parameters',
    );
    expect(findPathItem(document, 'post', '/api/groups/{}')).toBeUndefined();
    expect(findPathItem(document, 'get', '/api/unbekannt')).toBeUndefined();
  });

  it('describes name, location, requirement and type, through $ref too', () => {
    const { operation, pathItem } = operationOf('/api/persons');
    expect(schemas.parameterDetails(operation, pathItem)).toEqual([
      {
        name: 'ids[]',
        location: 'query',
        required: false,
        type: 'Liste',
        itemType: 'ganze Zahl',
        deprecated: false,
        enumCount: undefined,
      },
      {
        name: 'query',
        location: 'query',
        required: false,
        type: 'Text',
        itemType: undefined,
        deprecated: false,
        enumCount: undefined,
      },
      {
        name: 'email',
        location: 'query',
        required: false,
        type: 'Text',
        itemType: undefined,
        deprecated: false,
        enumCount: undefined,
      },
      {
        name: 'page',
        location: 'query',
        required: false,
        type: 'ganze Zahl',
        itemType: undefined,
        deprecated: false,
        enumCount: undefined,
      },
      {
        name: 'limit',
        location: 'query',
        required: false,
        type: 'ganze Zahl',
        itemType: undefined,
        deprecated: false,
        enumCount: undefined,
      },
    ]);
  });

  it('adds the parameters of the path item', () => {
    const { operation, pathItem } = operationOf('/api/groups/{}/members');
    const details = schemas.parameterDetails(operation, pathItem);
    expect(details.map((entry) => `${entry.location} ${entry.name}`)).toEqual([
      'path groupId',
      'query page',
      'query limit',
      'query query',
      'query personFields[]',
    ]);
    expect(details[0]).toMatchObject({ required: true, type: 'ganze Zahl' });
    // The old helper knew only the names of the query parameters.
    expect([...schemas.queryParameters(operation)]).not.toContain('groupId');
  });

  it('counts the values of an enumeration and never keeps them', () => {
    const { operation, pathItem } = operationOf('/api/search');
    const details = schemas.parameterDetails(operation, pathItem);
    expect(details).toEqual([
      expect.objectContaining({ name: 'query', required: true, type: 'Text' }),
      expect.objectContaining({
        name: 'domain_types[]',
        type: 'Liste',
        itemType: 'Text',
        enumCount: 3,
      }),
    ]);
    expect(JSON.stringify(details)).not.toContain('person');
  });

  it('lets a parameter of the operation replace one of the path item', () => {
    const own = asOpenApi({
      openapi: '3.1.0',
      paths: {
        '/x/{id}': {
          parameters: [
            { name: 'id', in: 'path', schema: { type: 'integer' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
          get: {
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                deprecated: true,
                schema: { type: ['string', 'null'] },
              },
            ],
          },
        },
      },
    });
    if (own === undefined) {
      throw new Error('document not accepted');
    }
    const operation = findOperation(own, 'get', '/x/{}');
    const pathItem = findPathItem(own, 'get', '/x/{}');
    expect(operation).toBeDefined();
    const details =
      operation === undefined
        ? []
        : new Schemas(own).parameterDetails(operation, pathItem);
    expect(details).toEqual([
      expect.objectContaining({ location: 'query', name: 'q', type: 'Text' }),
      expect.objectContaining({
        location: 'path',
        name: 'id',
        required: true,
        deprecated: true,
        type: 'Text',
      }),
    ]);
  });

  it('reads the type of a Swagger 2 parameter from the parameter itself', () => {
    const swagger = asOpenApi({
      swagger: '2.0',
      paths: {
        '/x': {
          get: {
            parameters: [
              {
                name: 'ids',
                in: 'query',
                type: 'array',
                items: { type: 'integer', enum: [1, 2] },
              },
            ],
          },
        },
      },
    });
    const operation = swagger && findOperation(swagger, 'get', '/x');
    expect(
      swagger && operation && new Schemas(swagger).parameterDetails(operation),
    ).toEqual([
      {
        name: 'ids',
        location: 'query',
        required: false,
        type: 'Liste',
        itemType: 'ganze Zahl',
        deprecated: false,
        enumCount: 2,
      },
    ]);
  });
});
