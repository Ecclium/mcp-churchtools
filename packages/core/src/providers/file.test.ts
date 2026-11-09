import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  maxProvidersFileBytes,
  providersCodes,
  readProvidersFile,
} from './file.js';

// Real files in a temporary folder. The checks of the file itself are the
// same as for every file of the configuration and tested there; here each
// kind of problem is shown once with its code.

const providersText = [
  '# Providers of the parish',
  'schema: providers.v1',
  'providers:',
  '  - alias: default',
  '    vendor: example',
  '    model: example-model-1',
  '    hostingCountry: CH',
  '    endpoint: https://model.example.org/v1/chat/completions',
  '    structuredOutput: true',
  '    apiKeyFile: /path/to/model-key',
  '',
].join('\n');

let folder = '';

const file = (name: string, content: string, mode = 0o600): string => {
  const path = join(folder, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-providers-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('readProvidersFile', () => {
  it('reads, parses and checks a file that others may read', () => {
    const result = readProvidersFile(
      file('providers.yaml', providersText, 0o644),
    );
    expect(result).toMatchObject({
      ok: true,
      providers: [{ alias: 'default', info: { hostingCountry: 'CH' } }],
    });
  });

  it('refuses a file the group may write', () => {
    expect(readProvidersFile(file('mode.yaml', providersText, 0o620))).toEqual({
      ok: false,
      code: 'providers_file_mode',
    });
  });

  it('refuses a relative path and a missing file', () => {
    expect(readProvidersFile('providers.yaml')).toEqual({
      ok: false,
      code: 'providers_file_relative',
    });
    expect(readProvidersFile(join(folder, 'missing.yaml'))).toEqual({
      ok: false,
      code: 'providers_file_missing',
    });
  });

  it('refuses a file above 64 KiB', () => {
    expect(maxProvidersFileBytes).toBe(65_536);
    expect(
      readProvidersFile(
        file('large.yaml', `${providersText}#${'x'.repeat(65_536)}\n`),
      ),
    ).toEqual({ ok: false, code: 'providers_file_too_large' });
  });

  it('names the line of a problem of YAML', () => {
    expect(
      readProvidersFile(
        file('syntax.yaml', 'schema: providers.v1\nproviders: [\n'),
      ),
    ).toMatchObject({ ok: false, code: 'providers_yaml_syntax', line: 3 });
    expect(
      readProvidersFile(file('anchor.yaml', 'schema: &v providers.v1\n')),
    ).toMatchObject({ ok: false, code: 'providers_yaml_unsupported' });
  });

  it('passes on the problems of the check', () => {
    expect(
      readProvidersFile(file('version.yaml', 'schema: providers.v2\n')),
    ).toEqual({
      ok: false,
      code: 'providers_version_unknown',
      field: 'schema',
    });
  });

  it('throws for a path that is no string', () => {
    expect(() => readProvidersFile(1 as unknown as string)).toThrow(TypeError);
  });

  it('has a code for each reason, frozen', () => {
    expect(providersCodes).toHaveLength(20);
    expect(Object.isFrozen(providersCodes)).toBe(true);
    for (const code of providersCodes) expect(code).toMatch(/^providers_/);
  });
});
