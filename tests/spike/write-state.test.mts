// The write state of 05-wiki-write: created exclusively and privately,
// every page recorded at once, and read back only for the same instance
// and write area.
import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { instanceId } from '../../scripts/spike/lib/env.mts';
import { SpikeError } from '../../scripts/spike/lib/errors.mts';
import {
  WriteStateFile,
  checkNewWriteState,
  readWriteState,
} from '../../scripts/spike/lib/write-state.mts';
import { privateFiles } from './support.mts';
import { makeGuid, writeOrigin } from './write-support.mts';

const category = 4711;

function hintOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof SpikeError
      ? (error.hint ?? error.code)
      : 'no SpikeError';
  }
  return 'passed';
}

function newPath(): string {
  return join(privateFiles('t').folder, 'schreib-state.jsonl');
}

describe('the write state', () => {
  it('records pages and their state at once, with mode 0600, and reads them back', () => {
    const path = newPath();
    checkNewWriteState(path);
    const file = WriteStateFile.create(path, writeOrigin, category);
    const first = makeGuid();
    const second = makeGuid();
    file.addPage(first, 'markdown1');
    // Already on disk before the file is closed, as after a crash.
    expect(readWriteState(path, writeOrigin, category).pages).toEqual([
      { guid: first, role: 'markdown1', baseline: undefined },
    ]);
    file.addPage(second, 'faelle');
    file.setBaseline(first, { version: 1, textHash: 'a'.repeat(64) });
    file.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state = readWriteState(path, writeOrigin, category);
    expect(state.run).toBe(file.run);
    expect(state.run).toMatch(/^[0-9a-f]{8}$/);
    expect(state.instance).toBe(instanceId(writeOrigin));
    expect(state.pages).toEqual([
      {
        guid: first,
        role: 'markdown1',
        baseline: { version: 1, textHash: 'a'.repeat(64) },
      },
      { guid: second, role: 'faelle', baseline: undefined },
    ]);
  });

  it('refuses a path that exists, even as a link, or lies in a Git working tree', () => {
    const path = newPath();
    writeFileSync(path, '', { mode: 0o600 });
    expect(
      hintOf(() => {
        checkNewWriteState(path);
      }),
    ).toBe('schreibStateVorhanden');
    expect(
      hintOf(() => WriteStateFile.create(path, writeOrigin, category)),
    ).toBe('schreibStateVorhanden');
    const link = `${newPath()}.link`;
    symlinkSync(path, link);
    expect(
      hintOf(() => {
        checkNewWriteState(link);
      }),
    ).toBe('schreibStateVorhanden');
    const repo = privateFiles('t').folder;
    mkdirSync(join(repo, '.git'));
    const inRepo = join(repo, 'state.jsonl');
    expect(
      hintOf(() => {
        checkNewWriteState(inRepo);
      }),
    ).toBe('schreibStateUnsicher');
    expect(
      hintOf(() => WriteStateFile.create(inRepo, writeOrigin, category)),
    ).toBe('schreibStateUnsicher');
  });

  it('refuses a GUID of another form before it is written', () => {
    const path = newPath();
    const file = WriteStateFile.create(path, writeOrigin, category);
    expect(
      hintOf(() => {
        file.addPage('main', 'markdown1');
      }),
    ).toBe('INTERN');
    file.close();
    expect(readWriteState(path, writeOrigin, category).pages).toEqual([]);
  });

  it('belongs to one instance and one write area', () => {
    const path = newPath();
    WriteStateFile.create(path, writeOrigin, category).close();
    expect(
      hintOf(() => readWriteState(path, 'https://other.example', category)),
    ).toBe('schreibStateUngueltig');
    expect(hintOf(() => readWriteState(path, writeOrigin, category + 1))).toBe(
      'schreibStateUngueltig',
    );
  });

  const hash = 'a'.repeat(64);
  it.each<[string, (header: string, guid: string) => string]>([
    ['a line that is no JSON', (header) => `${header}\n{broken\n`],
    [
      'a missing final line break',
      (header, guid) => `${header}\n{"page":"${guid}","role":"markdown1"}`,
    ],
    [
      'a page that is no GUID',
      (header) => `${header}\n{"page":"main","role":"markdown1"}\n`,
    ],
    [
      'an unknown role',
      (header, guid) => `${header}\n{"page":"${guid}","role":"admin"}\n`,
    ],
    [
      'a page twice',
      (header, guid) =>
        `${header}\n{"page":"${guid}","role":"markdown1"}\n{"page":"${guid}","role":"faelle"}\n`,
    ],
    [
      'a state of an unknown page',
      (header, guid) =>
        `${header}\n{"baseline":"${guid}","version":1,"textHash":"${hash}"}\n`,
    ],
    [
      'a state without a hash',
      (header, guid) =>
        `${header}\n{"page":"${guid}","role":"markdown1"}\n{"baseline":"${guid}","version":1}\n`,
    ],
    ['an unknown line', (header) => `${header}\n{"delete":"all"}\n`],
    ['another format', () => `{"format":"other"}\n`],
  ])('refuses %s', (_, content) => {
    const path = newPath();
    WriteStateFile.create(path, writeOrigin, category).close();
    const header = readFileSync(path, 'utf8').trimEnd();
    writeFileSync(path, content(header, makeGuid()), { mode: 0o600 });
    expect(hintOf(() => readWriteState(path, writeOrigin, category))).toBe(
      'schreibStateUngueltig',
    );
  });

  it('is read only if it is private and exists', () => {
    const path = newPath();
    WriteStateFile.create(path, writeOrigin, category).close();
    const loose = `${path}.loose`;
    writeFileSync(loose, readFileSync(path), { mode: 0o644 });
    expect(hintOf(() => readWriteState(loose, writeOrigin, category))).toBe(
      'schreibStateUnsicher',
    );
    expect(
      hintOf(() => readWriteState(`${path}.missing`, writeOrigin, category)),
    ).toBe('schreibStateNichtGefunden');
  });
});
