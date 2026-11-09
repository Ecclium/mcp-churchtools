import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../http/index.js';
import { readProviderKey } from './key-file.js';

// The key is a canary made at run time, in a file of a temporary folder.

let folder = '';

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-model-key-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const keyFile = (content: string, mode: number): string => {
  const path = join(folder, `key-${mode.toString(8)}`);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

describe('readProviderKey', () => {
  it('reads the key as a secret that shows nothing of it', () => {
    const canary = makeCanary('token');
    const result = readProviderKey(keyFile(`${canary.value}\n`, 0o600));
    expect(result.ok).toBe(true);
    const key = result.ok ? result.value : undefined;
    expect(key).toBeInstanceOf(Secret);
    expect(inspect(key)).not.toContain(canary.value);
    expect(JSON.stringify(key)).not.toContain(canary.value);
  });

  it('refuses a key the group may read, like the token file', () => {
    const canary = makeCanary('token');
    expect(readProviderKey(keyFile(canary.value, 0o640))).toEqual({
      ok: false,
      code: 'token_file_mode',
    });
  });

  it('refuses a relative path', () => {
    expect(readProviderKey('model-key')).toMatchObject({
      ok: false,
      code: 'token_file_relative',
    });
  });
});
