import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { signInRefusals } from '../identity/refusals.js';
import { serializeBearerTokens } from './file.js';
import { createBearerSignIn } from './sign-in.js';
import {
  type BearerTokenEntry,
  createBearerToken,
  hashBearerToken,
} from './token.js';

// The check of the sign-in with a static bearer token (ADR 0074), against
// real files of tokens in a folder of its own. The clock is fixed, never
// the calendar of the machine, and every token is made at run time, so
// that none stands in this file.

const folder = mkdtempSync(join(tmpdir(), 'ecclium-bearer-sign-in-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const noon = (year: number, month: number, day: number): number =>
  Date.UTC(year, month - 1, day, 12);
const clockAt = (time: number) => Object.freeze({ now: () => time });
const today = clockAt(noon(2026, 11, 26));

let counter = 0;
// A file of tokens with the given entries, with the mode set after the
// write, since the umask could take bits off the mode of the write.
const fileWith = (text: string, mode = 0o600): string => {
  counter += 1;
  const path = join(folder, `tokens-${String(counter)}.yaml`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

const entryFor = (
  token: string,
  overrides: Partial<BearerTokenEntry> = {},
): BearerTokenEntry => ({
  name: 'claude-code-office',
  sha256: hashBearerToken(token),
  scopes: ['read'],
  createdAt: '2026-11-26',
  expiresAt: '2027-05-25',
  ...overrides,
});

const setup = (overrides: Partial<BearerTokenEntry> = {}) => {
  const token = createBearerToken();
  const path = fileWith(serializeBearerTokens([entryFor(token, overrides)]));
  return { token, path };
};

describe('a token that holds', () => {
  it('gives the identity of source bearer with the name and the scopes of its entry', async () => {
    const { token, path } = setup({ scopes: ['read', 'write'] });
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    const result = await signIn(`Bearer ${token}`);
    expect(result).toEqual({
      ok: true,
      identity: {
        source: 'bearer',
        subject: 'claude-code-office',
        scopes: ['read', 'write'],
      },
    });
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.identity.scopes)).toBe(true);
    expect(Object.getPrototypeOf(result.identity)).toBeNull();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    ['the scheme in lower case', (token: string) => `bearer ${token}`],
    ['the scheme in upper case', (token: string) => `BEARER ${token}`],
    ['more than one space', (token: string) => `Bearer   ${token}`],
  ])('takes %s', async (_name, header) => {
    const { token, path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(header(token))).resolves.toMatchObject({ ok: true });
  });

  it('holds from the first day to the end of the last day, in UTC', async () => {
    const { token, path } = setup({
      createdAt: '2026-11-26',
      expiresAt: '2026-12-03',
    });
    for (const time of [
      Date.UTC(2026, 10, 26, 0, 0, 0),
      Date.UTC(2026, 11, 3, 23, 59, 59, 999),
    ]) {
      const signIn = createBearerSignIn({
        tokensFile: path,
        clock: clockAt(time),
      });
      await expect(signIn(`Bearer ${token}`)).resolves.toMatchObject({
        ok: true,
      });
    }
  });
});

describe('a refused sign-in', () => {
  const refused = (reason: string) => ({ ok: false, reason });

  it.each([
    ['no header', null],
    ['an undefined header', undefined],
    ['an empty header', ''],
  ])('refuses %s as missing', async (_name, header) => {
    const { path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(header)).resolves.toEqual(refused('missing'));
  });

  it.each([
    ['another scheme', (token: string) => `Basic ${token}`],
    ['a token without a scheme', (token: string) => token],
    ['the scheme glued to the token', (token: string) => `Bearer${token}`],
    ['a tab after the scheme', (token: string) => `Bearer\t${token}`],
    ['a longer scheme', (token: string) => `Bearers ${token}`],
  ])('refuses %s as scheme', async (_name, header) => {
    const { token, path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(header(token))).resolves.toEqual(refused('scheme'));
  });

  it.each([
    ['the scheme alone', () => 'Bearer'],
    ['the scheme and a space', () => 'Bearer '],
    ['a short text', () => 'Bearer ecclium_mcp_short'],
    ['a token with text after it', (token: string) => `Bearer ${token}x`],
    [
      'two headers, joined by a comma',
      (token: string) => `Bearer ${token}, Bearer ${token}`,
    ],
    [
      'a token with another prefix',
      (token: string) =>
        `Bearer ${token.replace('ecclium_mcp_', 'ecclium_mcq_')}`,
    ],
  ])('refuses %s as form', async (_name, header) => {
    const { token, path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(header(token))).resolves.toEqual(refused('form'));
  });

  it('refuses a token with a wrong checksum', async () => {
    const { token, path } = setup();
    const last = token.slice(-1);
    const changed = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(`Bearer ${changed}`)).resolves.toEqual(
      refused('checksum'),
    );
  });

  it('checks the form before it reads the file', async () => {
    const signIn = createBearerSignIn({
      tokensFile: join(folder, 'no-such-file.yaml'),
      clock: today,
    });
    await expect(signIn('Bearer ecclium_mcp_short')).resolves.toEqual(
      refused('form'),
    );
    // Counter-check: a token of the right form reaches the file.
    await expect(signIn(`Bearer ${createBearerToken()}`)).resolves.toEqual(
      refused('tokens_file'),
    );
  });

  it('refuses a token that no entry has', async () => {
    const { path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(`Bearer ${createBearerToken()}`)).resolves.toEqual(
      refused('unknown'),
    );
  });

  it('refuses a token after its last day, and one before its first day', async () => {
    const { token, path } = setup({
      createdAt: '2026-11-26',
      expiresAt: '2026-12-03',
    });
    const after = createBearerSignIn({
      tokensFile: path,
      clock: clockAt(Date.UTC(2026, 11, 4)),
    });
    await expect(after(`Bearer ${token}`)).resolves.toEqual(refused('expired'));
    const before = createBearerSignIn({
      tokensFile: path,
      clock: clockAt(Date.UTC(2026, 10, 25, 23, 59, 59, 999)),
    });
    await expect(before(`Bearer ${token}`)).resolves.toEqual(
      refused('not_yet_valid'),
    );
  });

  it('reads the file anew for every request: a revoke holds from the next one on, a new token as well', async () => {
    const { token, path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: today });
    await expect(signIn(`Bearer ${token}`)).resolves.toMatchObject({
      ok: true,
    });
    const next = createBearerToken();
    writeFileSync(
      path,
      serializeBearerTokens([entryFor(next, { name: 'other-client' })]),
    );
    await expect(signIn(`Bearer ${token}`)).resolves.toEqual(
      refused('unknown'),
    );
    await expect(signIn(`Bearer ${next}`)).resolves.toMatchObject({
      ok: true,
      identity: { subject: 'other-client' },
    });
  });

  it.each([
    ['a missing file', () => join(folder, 'missing.yaml')],
    ['a file that is no YAML', () => fileWith('version: [\n')],
    ['a file of another version', () => fileWith('version: 2\ntokens: []\n')],
    [
      'a file the group may write',
      () => fileWith(serializeBearerTokens([]), 0o620),
    ],
  ])(
    'refuses every token while the file is %s, and takes it once the file holds again',
    async (_name, pathOf) => {
      const token = createBearerToken();
      const path = pathOf();
      const signIn = createBearerSignIn({ tokensFile: path, clock: today });
      await expect(signIn(`Bearer ${token}`)).resolves.toEqual(
        refused('tokens_file'),
      );
      writeFileSync(path, serializeBearerTokens([entryFor(token)]));
      chmodSync(path, 0o600);
      await expect(signIn(`Bearer ${token}`)).resolves.toMatchObject({
        ok: true,
      });
    },
  );

  it.each([
    [
      'a clock that throws',
      () => {
        throw new Error('no time');
      },
    ],
    ['a clock without a date', () => Number.NaN],
    ['a clock before 1970', () => Date.UTC(1969, 11, 31)],
  ])('refuses with failed for %s', async (_name, now) => {
    const { token, path } = setup();
    const signIn = createBearerSignIn({ tokensFile: path, clock: { now } });
    await expect(signIn(`Bearer ${token}`)).resolves.toEqual(refused('failed'));
  });

  it('names a reason of the fixed list only, and never the token', async () => {
    const { token, path } = setup({ expiresAt: '2026-11-26' });
    const signIn = createBearerSignIn({
      tokensFile: path,
      clock: clockAt(noon(2026, 11, 27)),
    });
    const result = await signIn(`Bearer ${token}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(signInRefusals).toContain(result.reason);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe('createBearerSignIn', () => {
  it.each([
    ['a path that is no string', { tokensFile: 7, clock: today }],
    ['no clock', { tokensFile: '/config/tokens.yaml' }],
    ['a clock without now', { tokensFile: '/config/tokens.yaml', clock: {} }],
  ])('refuses %s', (_name, options) => {
    expect(() => createBearerSignIn(options as never)).toThrow(TypeError);
  });
});
