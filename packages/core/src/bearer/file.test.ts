import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readConfigYaml } from '../config/yaml.js';
import {
  addDays,
  bearerTokensCodes,
  checkBearerTokens,
  maxBearerTokens,
  readBearerTokensFile,
  serializeBearerTokens,
} from './file.js';
import {
  type BearerTokenEntry,
  createBearerToken,
  hashBearerToken,
} from './token.js';

const folder = mkdtempSync(join(tmpdir(), 'ecclium-bearer-file-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

let counter = 0;
const fileWith = (text: string, mode = 0o600): string => {
  counter += 1;
  const path = join(folder, `tokens-${String(counter)}.yaml`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

const entry = (
  overrides: Partial<BearerTokenEntry> = {},
): BearerTokenEntry => ({
  name: 'claude-code-office',
  sha256: hashBearerToken(createBearerToken()),
  scopes: ['read'],
  createdAt: '2026-11-26',
  expiresAt: '2027-05-25',
  ...overrides,
});

// Plain values of a file with the given entries.
const fileOf = (tokens: readonly unknown[]): unknown => ({
  version: 1,
  tokens,
});

const roundTrip = (entries: readonly BearerTokenEntry[]): unknown => {
  const yaml = readConfigYaml(serializeBearerTokens(entries));
  if (!yaml.ok) throw new Error('The serialized text is no YAML.');
  return checkBearerTokens(yaml.value);
};

describe('addDays', () => {
  it('counts calendar days in UTC, over leap years and backwards', () => {
    expect(addDays('2026-11-26', 180)).toBe('2027-05-25');
    expect(addDays('2026-11-26', 7)).toBe('2026-12-03');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-11-26', 0)).toBe('2026-11-26');
  });

  it('refuses a day that is none and a number of days that is no integer', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(TypeError);
    expect(() => addDays('26-11-2026', 1)).toThrow(TypeError);
    expect(() => addDays('2026-11-26', 1.5)).toThrow(TypeError);
  });
});

describe('serializeBearerTokens and checkBearerTokens', () => {
  it('give back the same entries, in the order of the file', () => {
    const entries = [
      entry(),
      entry({ name: 'buero', scopes: ['read', 'write'] }),
      entry({ expiresAt: '2026-12-03' }),
    ];
    expect(roundTrip(entries)).toEqual({ ok: true, entries });
    expect(roundTrip([])).toEqual({ ok: true, entries: [] });
  });

  it('keeps names that YAML would read as other types, and hashes of digits, as strings', () => {
    const entries = [
      entry({ name: 'null' }),
      entry({ name: 'true' }),
      entry({ name: 'no' }),
      entry({ sha256: '1'.repeat(64) }),
      entry({ sha256: `1e${'2'.repeat(62)}` }),
    ];
    expect(roundTrip(entries)).toEqual({ ok: true, entries });
  });

  it('starts with a comment for the operator and names no token', () => {
    const token = createBearerToken();
    const text = serializeBearerTokens([
      entry({ sha256: hashBearerToken(token) }),
    ]);
    expect(text.startsWith('# ')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain('ecclium_mcp_');
  });

  it('refuses to write entries the server would refuse', () => {
    expect(() => serializeBearerTokens([entry({ name: 'Claude' })])).toThrow(
      TypeError,
    );
    const twice = entry();
    expect(() => serializeBearerTokens([twice, twice])).toThrow(TypeError);
  });

  it('takes days without quotes, as a person may write them', () => {
    const sha256 = hashBearerToken(createBearerToken());
    const yaml = readConfigYaml(
      [
        'version: 1',
        'tokens:',
        '  - name: buero',
        `    sha256: "${sha256}"`,
        '    scopes: [read]',
        '    createdAt: 2026-11-26',
        '    expiresAt: 2027-05-25',
        '',
      ].join('\n'),
    );
    expect(yaml.ok && checkBearerTokens(yaml.value).ok).toBe(true);
  });

  it('lets two entries share a name, for a rotation, but never a hash', () => {
    const first = entry();
    const second = entry({ expiresAt: '2026-12-03' });
    expect(checkBearerTokens(fileOf([first, second])).ok).toBe(true);
    expect(
      checkBearerTokens(fileOf([first, { ...second, sha256: first.sha256 }])),
    ).toEqual({
      ok: false,
      code: 'bearer_tokens_duplicate',
      field: 'tokens[1].sha256',
    });
  });

  it('refuses a file without its version or with another', () => {
    for (const value of [
      { tokens: [] },
      { version: 2, tokens: [] },
      { version: '1', tokens: [] },
    ]) {
      expect(checkBearerTokens(value)).toEqual({
        ok: false,
        code: 'bearer_tokens_version_unknown',
        field: 'version',
      });
    }
    for (const value of [undefined, null, [], 'version: 1']) {
      expect(checkBearerTokens(value)).toEqual({
        ok: false,
        code: 'bearer_tokens_version_unknown',
      });
    }
  });

  it('refuses each field of another form, with the path of the field', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ name: 'Claude' }, 'tokens[0].name'],
      [{ name: 'claude.code' }, 'tokens[0].name'],
      [{ name: `a${'b'.repeat(32)}` }, 'tokens[0].name'],
      [{ sha256: 'A'.repeat(64) }, 'tokens[0].sha256'],
      [{ sha256: 'a'.repeat(63) }, 'tokens[0].sha256'],
      [{ scopes: ['write'] }, 'tokens[0].scopes'],
      [{ scopes: ['write', 'read'] }, 'tokens[0].scopes'],
      [{ scopes: ['read', 'read'] }, 'tokens[0].scopes'],
      [{ scopes: [] }, 'tokens[0].scopes'],
      [{ scopes: ['read', 'write', 'admin'] }, 'tokens[0].scopes'],
      [{ createdAt: '2026-02-30' }, 'tokens[0].createdAt'],
      [{ expiresAt: 20270525 }, 'tokens[0].expiresAt'],
      [{ expiresAt: '2026-11-25' }, 'tokens[0].expiresAt'],
      [{ expiresAt: '2027-11-27' }, 'tokens[0].expiresAt'],
      [{ token: 'x' }, 'tokens[0]'],
    ];
    for (const [overrides, field] of cases) {
      expect(checkBearerTokens(fileOf([{ ...entry(), ...overrides }]))).toEqual(
        { ok: false, code: 'bearer_tokens_invalid', field },
      );
    }
    expect(
      checkBearerTokens(fileOf([entry({ expiresAt: '2027-11-26' })])).ok,
    ).toBe(true);
  });

  it('refuses more than 64 entries and an unknown key at the top', () => {
    const many = Array.from({ length: maxBearerTokens + 1 }, () => entry());
    expect(checkBearerTokens(fileOf(many))).toMatchObject({
      ok: false,
      code: 'bearer_tokens_invalid',
      field: 'tokens',
    });
    expect(checkBearerTokens(fileOf(many.slice(0, maxBearerTokens))).ok).toBe(
      true,
    );
    expect(
      checkBearerTokens({ version: 1, tokens: [], extra: true }),
    ).toMatchObject({ ok: false, code: 'bearer_tokens_invalid' });
  });

  it('returns deeply frozen entries', () => {
    const checked = checkBearerTokens(fileOf([entry()]));
    if (!checked.ok) throw new Error('Expected entries.');
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.entries)).toBe(true);
    expect(Object.isFrozen(checked.entries[0])).toBe(true);
    expect(Object.isFrozen(checked.entries[0]?.scopes)).toBe(true);
  });
});

describe('readBearerTokensFile', () => {
  it('reads a file of the user that others do not write', () => {
    const entries = [entry()];
    const path = fileWith(serializeBearerTokens(entries));
    expect(readBearerTokensFile(path)).toEqual({ ok: true, entries });
    expect(
      readBearerTokensFile(fileWith(serializeBearerTokens(entries), 0o644)).ok,
    ).toBe(true);
  });

  it('refuses a file that group or others may write, a link and a missing file', () => {
    const text = serializeBearerTokens([entry()]);
    expect(readBearerTokensFile(fileWith(text, 0o620))).toEqual({
      ok: false,
      code: 'bearer_tokens_file_mode',
    });
    expect(readBearerTokensFile(fileWith(text, 0o602))).toEqual({
      ok: false,
      code: 'bearer_tokens_file_mode',
    });
    const link = join(folder, 'link.yaml');
    symlinkSync(fileWith(text), link);
    expect(readBearerTokensFile(link)).toEqual({
      ok: false,
      code: 'bearer_tokens_file_symlink',
    });
    expect(readBearerTokensFile(join(folder, 'none.yaml'))).toEqual({
      ok: false,
      code: 'bearer_tokens_file_missing',
    });
    expect(readBearerTokensFile('tokens.yaml')).toEqual({
      ok: false,
      code: 'bearer_tokens_file_relative',
    });
  });

  it('refuses a file over 64 KiB and YAML it does not take, with the line', () => {
    expect(readBearerTokensFile(fileWith(`# ${'x'.repeat(65_536)}\n`))).toEqual(
      {
        ok: false,
        code: 'bearer_tokens_file_too_large',
      },
    );
    expect(
      readBearerTokensFile(fileWith('version: 1\ntokens: [\n')),
    ).toMatchObject({ ok: false, code: 'bearer_tokens_yaml_syntax' });
    expect(
      readBearerTokensFile(fileWith('version: 1\ntokens: &a []\n')),
    ).toEqual({ ok: false, code: 'bearer_tokens_yaml_unsupported', line: 2 });
  });

  it('names every code it may return in the frozen list', () => {
    expect(Object.isFrozen(bearerTokensCodes)).toBe(true);
    expect(new Set(bearerTokensCodes).size).toBe(bearerTokensCodes.length);
  });
});
