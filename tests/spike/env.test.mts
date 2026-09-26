import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkNewState,
  checkNodeEnvironment,
  createState,
  instanceId,
  isInsideGitWorkTree,
  readCategoryId,
  readOrigin,
  readState,
  readToken,
  type SpikeState,
} from '../../scripts/spike/lib/env.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import { asOpenApi } from '../../scripts/spike/lib/spec.mts';
import {
  makeCanaries,
  origin,
  privateFiles,
  specification,
} from './support.mts';

const hintOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof SpikeError ? error.hint : 'no SpikeError';
  }
  return undefined;
};

describe('checkNodeEnvironment', () => {
  it.each([
    ['NODE_OPTIONS', '--require ./x.js'],
    ['NODE_DEBUG', 'http'],
    ['NODE_PATH', '/x'],
    ['NODE_EXTRA_CA_CERTS', '/x.pem'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
  ])('refuses %s', (name, value) => {
    expect(
      hintOf(() => {
        checkNodeEnvironment({ [name]: value });
      }),
    ).toBe('umgebungUnsicher');
  });

  it('accepts a clean environment', () => {
    expect(
      hintOf(() => {
        checkNodeEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: '1' });
      }),
    ).toBeUndefined();
  });
});

describe('readOrigin', () => {
  it('returns the origin of a plain https address', () => {
    expect(readOrigin({ ECCLIUM_SPIKE_BASE_URL: origin })).toBe(origin);
    expect(readOrigin({ ECCLIUM_SPIKE_BASE_URL: `${origin}/` })).toBe(origin);
  });

  it.each([
    'http://example.church.tools',
    'https://user@example.org',
    'https://example.church.tools/api',
    'https://example.church.tools/?x=1',
    'https://example.church.tools/#x',
    'https://example.church.tools?',
    'not a url',
  ])('refuses %s', (value) => {
    expect(hintOf(() => readOrigin({ ECCLIUM_SPIKE_BASE_URL: value }))).toBe(
      'basisUrlUngueltig',
    );
  });

  it('asks for a missing address', () => {
    expect(hintOf(() => readOrigin({}))).toBe('basisUrlFehlt');
  });
});

describe('readCategoryId', () => {
  it('reads positive whole numbers only', () => {
    const name = 'ECCLIUM_SPIKE_WIKI_CATEGORY_ID';
    expect(readCategoryId({ [name]: '7' }, name, true)).toBe(7);
    expect(hintOf(() => readCategoryId({}, name, true))).toBe('kategorieFehlt');
    for (const value of ['0', '-1', '1.5', '7 ', 'x']) {
      expect(hintOf(() => readCategoryId({ [name]: value }, name, true))).toBe(
        'kategorieFehlt',
      );
    }
    const optional = 'ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID';
    expect(readCategoryId({}, optional, false)).toBeUndefined();
    expect(
      hintOf(() => readCategoryId({ [optional]: 'x' }, optional, false)),
    ).toBe('gesperrteKategorieUngueltig');
  });
});

describe('readToken', () => {
  it('reads one line of printable ASCII from a private file', () => {
    const { token } = makeCanaries();
    const { tokenFile } = privateFiles(token);
    expect(readToken({ ECCLIUM_SPIKE_TOKEN_FILE: tokenFile })).toBe(token);
  });

  it('refuses a file that others may read', () => {
    const { tokenFile } = privateFiles(makeCanaries().token);
    chmodSync(tokenFile, 0o640);
    expect(
      hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: tokenFile })),
    ).toBe('tokenDateiUnsicher');
  });

  it('refuses a link, even to a private file', () => {
    const { folder, tokenFile } = privateFiles(makeCanaries().token);
    const link = join(folder, 'link');
    symlinkSync(tokenFile, link);
    expect(hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: link }))).toBe(
      'tokenDateiUnsicher',
    );
  });

  it('refuses a large file and one that is not a single token line', () => {
    const { tokenFile } = privateFiles('x');
    writeFileSync(tokenFile, 'a'.repeat(5000));
    expect(
      hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: tokenFile })),
    ).toBe('tokenDateiUnsicher');
    for (const content of ['one\ntwo\n', 'with space', 'ümlaut', '\n']) {
      writeFileSync(tokenFile, content);
      expect(
        hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: tokenFile })),
      ).toBe('tokenUngueltig');
    }
  });

  it('refuses a file inside a Git working tree', () => {
    const { folder } = privateFiles('x');
    mkdirSync(join(folder, 'repo', '.git'), { recursive: true });
    const inside = join(folder, 'repo', 'token');
    writeFileSync(inside, 'token\n', { mode: 0o600 });
    expect(isInsideGitWorkTree(inside)).toBe(true);
    expect(hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: inside }))).toBe(
      'tokenDateiUnsicher',
    );
  });

  it('asks for a missing variable and a missing file', () => {
    expect(hintOf(() => readToken({}))).toBe('tokenDateiFehlt');
    expect(
      hintOf(() => readToken({ ECCLIUM_SPIKE_TOKEN_FILE: '/nonexistent/x' })),
    ).toBe('tokenDateiNichtGefunden');
  });
});

describe('state file', () => {
  const document = asOpenApi(specification);
  if (document === undefined) {
    throw new Error('synthetic document is not accepted');
  }
  const state: SpikeState = {
    format: 'ecclium-spike-state.v1',
    instance: instanceId(origin),
    version: '3.136',
    specification: document,
  };

  it('is created once, privately, and read back for the same instance only', () => {
    const { stateFile } = privateFiles('x');
    createState(stateFile, state);
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(readState(stateFile, origin)).toEqual(state);
    expect(
      hintOf(() => {
        createState(stateFile, state);
      }),
    ).toBe('stateDateiVorhanden');
    expect(
      hintOf(() => readState(stateFile, 'https://other.example.org')),
    ).toBe('stateDateiUngueltig');
  });

  it('refuses damaged content and files others may read', () => {
    const { stateFile } = privateFiles('x');
    createState(stateFile, state);
    const content = readFileSync(stateFile, 'utf8');
    writeFileSync(stateFile, content.slice(0, 20));
    expect(hintOf(() => readState(stateFile, origin))).toBe(
      'stateDateiUngueltig',
    );
    writeFileSync(stateFile, JSON.stringify({ ...state, format: 'x' }));
    expect(hintOf(() => readState(stateFile, origin))).toBe(
      'stateDateiUngueltig',
    );
    chmodSync(stateFile, 0o644);
    expect(hintOf(() => readState(stateFile, origin))).toBe(
      'stateDateiUnsicher',
    );
  });

  it('names a missing file apart from an unsafe one', () => {
    const { stateFile } = privateFiles('x');
    expect(hintOf(() => readState(stateFile, origin))).toBe(
      'stateDateiNichtGefunden',
    );
  });

  it('is checked before the first request of 00-inventory', () => {
    const { folder, stateFile } = privateFiles('x');
    expect(
      hintOf(() => {
        checkNewState(stateFile);
      }),
    ).toBeUndefined();
    symlinkSync(join(folder, 'nowhere'), stateFile);
    expect(
      hintOf(() => {
        checkNewState(stateFile);
      }),
    ).toBe('stateDateiVorhanden');
    mkdirSync(join(folder, 'repo', '.git'), { recursive: true });
    expect(
      hintOf(() => {
        checkNewState(join(folder, 'repo', 'state.json'));
      }),
    ).toBe('stateDateiUnsicher');
  });

  it('is not created inside a Git working tree', () => {
    const { folder } = privateFiles('x');
    mkdirSync(join(folder, 'repo', '.git'), { recursive: true });
    expect(
      hintOf(() => {
        createState(join(folder, 'repo', 'state.json'), state);
      }),
    ).toBe('stateDateiUnsicher');
  });
});
