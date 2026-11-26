import { describe, expect, it } from 'vitest';

import { loadTokenCommandConfig } from './load.js';

const tokensPath = '/path/to/http-tokens.yaml';

const problemsOf = (
  result: ReturnType<typeof loadTokenCommandConfig>,
): string[][] =>
  result.ok
    ? []
    : result.problems.map(({ code, variable }) =>
        variable === undefined ? [code] : [code, variable],
      );

describe('loadTokenCommandConfig', () => {
  it('takes the path of the file alone and needs neither address nor token', () => {
    expect(
      loadTokenCommandConfig({
        environment: { ECCLIUM_HTTP_TOKENS_FILE: tokensPath },
      }),
    ).toEqual({ ok: true, config: { httpTokensFile: tokensPath } });
  });

  it('reads no other value, also not a wrong one', () => {
    const result = loadTokenCommandConfig({
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: tokensPath,
        ECCLIUM_CHURCHTOOLS_URL: 'not an address',
        ECCLIUM_READ_ONLY: 'perhaps',
        PATH: '/usr/bin',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('needs the variable', () => {
    const result = loadTokenCommandConfig({ environment: {} });
    expect(problemsOf(result)).toEqual([
      ['http_tokens_file_required', 'ECCLIUM_HTTP_TOKENS_FILE'],
    ]);
  });

  it('refuses an empty value, a long one and a path of another form', () => {
    const cases: readonly [string, string][] = [
      ['', 'empty_value'],
      [`/${'a'.repeat(4096)}`, 'value_too_long'],
      ['http-tokens.yaml', 'http_tokens_file_invalid'],
      ['/path/to/../http-tokens.yaml', 'http_tokens_file_invalid'],
    ];
    for (const [value, code] of cases) {
      const result = loadTokenCommandConfig({
        environment: { ECCLIUM_HTTP_TOKENS_FILE: value },
      });
      expect(problemsOf(result)).toEqual([[code, 'ECCLIUM_HTTP_TOKENS_FILE']]);
    }
  });

  it('stops for an unknown or miscased name, as the start does', () => {
    const result = loadTokenCommandConfig({
      environment: {
        ECCLIUM_HTTP_TOKENS_FILE: tokensPath,
        ECCLIUM_HTTP_TOKEN_FILE: tokensPath,
        ecclium_http_tokens_file: tokensPath,
      },
    });
    expect(problemsOf(result).map(([code]) => code)).toEqual(
      expect.arrayContaining(['unknown_variable', 'miscased_variable']),
    );
  });

  it('refuses sources that are no plain record, without a value in the message', () => {
    for (const sources of [undefined, null, [], { environment: [] }]) {
      expect(() =>
        loadTokenCommandConfig(
          sources as unknown as Parameters<typeof loadTokenCommandConfig>[0],
        ),
      ).toThrow(TypeError);
    }
  });

  it('returns frozen results', () => {
    const good = loadTokenCommandConfig({
      environment: { ECCLIUM_HTTP_TOKENS_FILE: tokensPath },
    });
    const bad = loadTokenCommandConfig({ environment: {} });
    expect(Object.isFrozen(good)).toBe(true);
    expect(Object.isFrozen(bad)).toBe(true);
  });
});
