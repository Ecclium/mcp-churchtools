import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ConfigResult, loadConfig, tokenVariableName } from '../index.js';
import { revealSecret } from './secret.js';

// The tests of the loader check codes and types. Only here, in the folder
// that may turn a secret back into its value (ADR 0054), does a test check
// that the exact token arrives in the Secret, from a real file and from the
// environment.

const address = 'https://example.church.tools';

const revealed = (result: ConfigResult): string => {
  if (!result.ok) throw new Error('the configuration did not load');
  return revealSecret(result.config.churchtoolsToken);
};

describe('the token after loadConfig', () => {
  let directory = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ecclium-config-token-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const fromFile = (path: string): ConfigResult =>
    loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: address,
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: path,
      },
      transport: 'stdio',
    });

  const write = (path: string, content: string): void => {
    writeFileSync(path, content);
    chmodSync(path, 0o600);
  };

  it.each(['\n', '\r\n', ''])(
    'is the content of the file without the line ending %j',
    (ending) => {
      const canary = makeCanary('token').value;
      const path = join(directory, `token-${String(ending.length)}`);
      write(path, `${canary}${ending}`);
      expect(revealed(fromFile(path))).toBe(canary);
    },
  );

  it('is read again on every load', () => {
    const path = join(directory, 'token-again');
    const first = makeCanary('token').value;
    const second = makeCanary('token').value;
    write(path, `${first}\n`);
    const before = fromFile(path);
    write(path, `${second}\n`);
    const after = fromFile(path);
    expect(revealed(before)).toBe(first);
    expect(revealed(after)).toBe(second);
  });

  it('is the value of the environment variable over stdio', () => {
    const canary = makeCanary('token').value;
    const result = loadConfig({
      environment: {
        ECCLIUM_CHURCHTOOLS_URL: address,
        [tokenVariableName]: canary,
      },
      transport: 'stdio',
    });
    expect(revealed(result)).toBe(canary);
  });
});
