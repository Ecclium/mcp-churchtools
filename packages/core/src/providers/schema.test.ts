import { describe, expect, it } from 'vitest';

import {
  checkProviders,
  providersCheckCodes,
  providersJsonSchema,
  providersLimits,
} from './schema.js';

// Values are placeholders: hosts under .example (RFC 2606), paths under
// /path/to.

const entry = (change: Record<string, unknown> = {}) => ({
  alias: 'default',
  vendor: 'example',
  model: 'example-model-1',
  hostingCountry: 'CH',
  endpoint: 'https://model.example.org/v1/chat/completions',
  structuredOutput: true,
  apiKeyFile: '/path/to/model-key',
  ...change,
});

const file = (...entries: unknown[]) => ({
  schema: 'providers.v1',
  providers: entries,
});

describe('checkProviders', () => {
  it('gives each provider with its information, frozen and in order', () => {
    const result = checkProviders(
      file(
        entry(),
        entry({
          alias: 'extern',
          model: 'example-maker/example-model-2',
          hostingCountry: 'US',
          endpoint: 'https://model.example.com:8443/v1/chat/completions',
          structuredOutput: false,
          transferBasis: 'binding_corporate_rules',
        }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      providers: [
        {
          alias: 'default',
          info: {
            vendor: 'example',
            model: 'example-model-1',
            hostingCountry: 'CH',
            endpointHost: 'model.example.org',
          },
          endpoint: 'https://model.example.org/v1/chat/completions',
          structuredOutput: true,
          apiKeyFile: '/path/to/model-key',
        },
        {
          alias: 'extern',
          info: {
            vendor: 'example',
            model: 'example-maker/example-model-2',
            hostingCountry: 'US',
            endpointHost: 'model.example.com',
            transferBasis: 'binding_corporate_rules',
          },
          endpoint: 'https://model.example.com:8443/v1/chat/completions',
          structuredOutput: false,
          apiKeyFile: '/path/to/model-key',
        },
      ],
    });
    expect(result.ok && Object.isFrozen(result.providers)).toBe(true);
    expect(result.ok && Object.isFrozen(result.providers[0]?.info)).toBe(true);
  });

  it.each([
    [undefined, undefined],
    ['providers.v1', undefined],
    [[], undefined],
    [{ schema: 'providers.v2' }, 'schema'],
    [{ providers: [] }, 'schema'],
  ])('refuses %j as of an unknown version', (value, field) => {
    expect(checkProviders(value)).toEqual({
      ok: false,
      code: 'providers_version_unknown',
      ...(field === undefined ? {} : { field }),
    });
  });

  it.each([
    'apiKey',
    'api_key',
    'API-Key',
    'key',
    'token',
    'secret',
    'password',
    'authorization',
    'bearer',
  ])('refuses a field %s as a key in the file, before the schema', (name) => {
    expect(
      checkProviders(file(entry(), entry({ alias: 'b', [name]: 'x' }))),
    ).toEqual({
      ok: false,
      code: 'providers_key_inline',
      field: 'providers[1]',
    });
  });

  it('passes over an entry that is no object on its way to the schema', () => {
    expect(checkProviders(file(null, entry()))).toEqual({
      ok: false,
      code: 'providers_invalid',
      field: 'providers[0]',
    });
  });

  it.each<[string, unknown, string | undefined]>([
    ['no providers', { schema: 'providers.v1', providers: [] }, 'providers'],
    [
      'eleven providers',
      file(
        ...Array.from({ length: providersLimits.providers + 1 }, (_v, i) =>
          entry({ alias: `p${String(i)}` }),
        ),
      ),
      'providers',
    ],
    ['an unknown field', file(entry({ region: 'x' })), 'providers[0]'],
    [
      'an alias with capitals',
      file(entry({ alias: 'Default' })),
      'providers[0].alias',
    ],
    [
      'a vendor with a space',
      file(entry({ vendor: 'ex ample' })),
      'providers[0].vendor',
    ],
    [
      'a model with two slashes',
      file(entry({ model: 'a/b/c' })),
      'providers[0].model',
    ],
    [
      'a country of three letters',
      file(entry({ hostingCountry: 'CHE' })),
      'providers[0].hostingCountry',
    ],
    [
      'an endpoint with http',
      file(entry({ endpoint: 'http://model.example.org/v1' })),
      'providers[0].endpoint',
    ],
    [
      'an endpoint without a path',
      file(entry({ endpoint: 'https://model.example.org' })),
      'providers[0].endpoint',
    ],
    [
      'an endpoint with a query',
      file(entry({ endpoint: 'https://model.example.org/v1?key=x' })),
      'providers[0].endpoint',
    ],
    [
      'an endpoint on an IP address',
      file(entry({ endpoint: 'https://10.0.0.1/v1' })),
      'providers[0].endpoint',
    ],
    [
      'structured output as text',
      file(entry({ structuredOutput: 'yes' })),
      'providers[0].structuredOutput',
    ],
    [
      'a relative path of the key',
      file(entry({ apiKeyFile: 'model-key' })),
      'providers[0].apiKeyFile',
    ],
    [
      'an unknown basis',
      file(entry({ hostingCountry: 'US', transferBasis: 'consent' })),
      'providers[0].transferBasis',
    ],
  ])('refuses %s with the path of its field', (_case, value, field) => {
    expect(checkProviders(value)).toEqual({
      ok: false,
      code: 'providers_invalid',
      ...(field === undefined ? {} : { field }),
    });
  });

  it('refuses an alias twice', () => {
    expect(checkProviders(file(entry(), entry()))).toEqual({
      ok: false,
      code: 'providers_contradiction',
      field: 'providers[1].alias',
    });
  });

  it('refuses a provider outside Switzerland and the EEA without a basis', () => {
    expect(
      checkProviders(
        file(entry(), entry({ alias: 'b', hostingCountry: 'US' })),
      ),
    ).toEqual({
      ok: false,
      code: 'providers_transfer_basis_missing',
      field: 'providers[1].transferBasis',
    });
  });

  it('refuses a basis inside Switzerland and the EEA', () => {
    expect(
      checkProviders(file(entry({ transferBasis: 'adequacy_decision' }))),
    ).toEqual({
      ok: false,
      code: 'providers_transfer_basis_needless',
      field: 'providers[0].transferBasis',
    });
  });

  it('never names a value in a problem', () => {
    const result = checkProviders(
      file(entry({ endpoint: 'https://secret-host.example/v1?x=1' })),
    );
    expect(JSON.stringify(result)).not.toContain('secret-host');
  });

  it('has six codes, frozen', () => {
    expect(providersCheckCodes).toHaveLength(6);
    expect(Object.isFrozen(providersCheckCodes)).toBe(true);
  });
});

describe('providersJsonSchema', () => {
  it('describes a strict file of the version providers.v1', () => {
    const schema = providersJsonSchema() as {
      type: string;
      additionalProperties: boolean;
      properties: {
        schema: { const: string };
        providers: { maxItems: number };
      };
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schema.const).toBe('providers.v1');
    expect(schema.properties.providers.maxItems).toBe(10);
    expect(providersJsonSchema()).not.toBe(providersJsonSchema());
  });
});
