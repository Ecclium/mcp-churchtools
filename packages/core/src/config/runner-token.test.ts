import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../http/index.js';
import {
  readRunnerToken,
  runnerTokenCodeOf,
  runnerTokenCodes,
} from './runner-token.js';
import { tokenFileCodes, type TokenFileSystem } from './token-file.js';

// The token of an account of the runner, a canary made at run time, in a
// file of a temporary folder (ADR 0033).

let folder = '';

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'ecclium-runner-tokens-'));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

// The file functions of Node.js, with the path of every open.
const recording = (): { fs: TokenFileSystem; opened: string[] } => {
  const opened: string[] = [];
  return {
    opened,
    fs: {
      openSync: (path, flags) => {
        opened.push(path);
        return openSync(path, flags);
      },
      fstatSync,
      readSync,
      closeSync,
      getuid: () => process.getuid?.(),
      constants,
    },
  };
};

const tokenFile = (alias: string, content: string, mode = 0o600): void => {
  const path = join(folder, `ct_token_${alias}`);
  writeFileSync(path, content);
  chmodSync(path, mode);
};

describe('readRunnerToken', () => {
  it('reads the file of the alias as a secret that shows nothing of it', () => {
    const canary = makeCanary('token');
    tokenFile('berichte', `${canary.value}\n`);
    const result = readRunnerToken(folder, 'berichte');
    expect(result.ok).toBe(true);
    const token = result.ok ? result.value : undefined;
    expect(token).toBeInstanceOf(Secret);
    expect(inspect(token)).not.toContain(canary.value);
    expect(JSON.stringify(token)).not.toContain(canary.value);
  });

  it('opens the file of its alias anew on each call, so a new token counts at once', () => {
    tokenFile('wechsel', makeCanary('token').value);
    const { fs, opened } = recording();
    expect(readRunnerToken(folder, 'wechsel', fs).ok).toBe(true);
    tokenFile('wechsel', makeCanary('token').value);
    expect(readRunnerToken(folder, 'wechsel', fs).ok).toBe(true);
    expect(opened).toEqual([
      `${folder}/ct_token_wechsel`,
      `${folder}/ct_token_wechsel`,
    ]);
  });

  it('reads only the file of its alias', () => {
    const canary = makeCanary('token');
    tokenFile('andere', canary.value);
    expect(readRunnerToken(folder, 'fehlt')).toEqual({
      ok: false,
      code: 'token_file_missing',
    });
  });

  it('refuses a file the group may read, like the token file', () => {
    tokenFile('offen', makeCanary('token').value, 0o640);
    expect(readRunnerToken(folder, 'offen')).toEqual({
      ok: false,
      code: 'token_file_mode',
    });
  });

  it('follows no link in place of the file', () => {
    const target = join(folder, 'target');
    writeFileSync(target, makeCanary('token').value, { mode: 0o600 });
    symlinkSync(target, join(folder, 'ct_token_link'));
    expect(readRunnerToken(folder, 'link')).toEqual({
      ok: false,
      code: 'token_file_symlink',
    });
  });

  it('refuses a folder in place of the file', () => {
    mkdirSync(join(folder, 'ct_token_ordner'), { mode: 0o700 });
    expect(readRunnerToken(folder, 'ordner').ok).toBe(false);
  });

  it.each([
    '../berichte',
    'Berichte',
    'berichte/x',
    '',
    '-berichte',
    'a'.repeat(64),
  ])('throws for the alias %j, which no policy names', (alias) => {
    expect(() => readRunnerToken(folder, alias)).toThrow(TypeError);
  });

  it.each(['tokens', '/path/to/tokens/', '/path/../tokens', '/path//tokens'])(
    'throws for the folder %s, which the configuration refuses',
    (dir) => {
      expect(() => readRunnerToken(dir, 'berichte')).toThrow(TypeError);
    },
  );
});

describe('runnerTokenCodeOf', () => {
  // A file in the checked folder is never relative, and without the checks
  // of the platform the loader refuses the folder before any file, so
  // these two codes name the folder (ADR 0033).
  it('names the folder for the two codes a file in it cannot have', () => {
    expect(runnerTokenCodeOf('token_file_relative')).toBe(
      'runner_tokens_dir_invalid',
    );
    expect(runnerTokenCodeOf('token_file_platform')).toBe(
      'runner_tokens_dir_platform',
    );
  });

  it('gives every other code of the token file its code of the runner', () => {
    const others = tokenFileCodes.filter(
      (code) =>
        code !== 'token_file_relative' && code !== 'token_file_platform',
    );
    expect(others.map(runnerTokenCodeOf)).toEqual(runnerTokenCodes);
  });
});
