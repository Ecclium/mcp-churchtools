import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  BaseSequencer,
  type TestSpecification,
  type Vitest,
} from 'vitest/node';

import config from '../../vitest.config.mts';
import {
  LongFilesFirst,
  longFiles,
  startLongFilesFirst,
} from './long-files-first.mts';

// The workspace sets the order of its test files and the number of workers
// (see long-files-first.mts). A name in the list that matches no file would
// let a long file start late without a failure.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const file = (path: string): { moduleId: string } => ({
  moduleId: join(workspace, path),
});

describe('the long test files', () => {
  it('are test files of the workspace, each named once', () => {
    expect(new Set(longFiles).size).toBe(longFiles.length);
    for (const path of longFiles) {
      expect(path).toMatch(/^tests\/.+\.test\.mts$/);
      expect(existsSync(join(workspace, path)), path).toBe(true);
    }
  });

  it('start first, in the order of the list, and the rest keeps its order', () => {
    const [first = '', second = ''] = longFiles;
    const files = [
      file('tests/other.test.mts'),
      file(second),
      file('packages/core/src/other.test.ts'),
      file(first),
    ];
    expect(
      startLongFilesFirst(files, workspace).map((entry) => entry.moduleId),
    ).toEqual(
      [
        first,
        second,
        'tests/other.test.mts',
        'packages/core/src/other.test.ts',
      ].map((path) => join(workspace, path)),
    );
  });

  it('start first when Vitest sorts the files of a run', async () => {
    // Only what the sort of Vitest reads, without a cache. The other files
    // go in against the order Vitest gives them and must come out in it.
    const project = {
      name: '',
      config: { sequence: { groupOrder: 0 }, isolate: true },
    };
    const ctx = {
      config: { root: workspace },
      cache: { getTestSpecificationResult: () => undefined },
    } as unknown as Vitest;
    const spec = (path: string): TestSpecification =>
      ({ ...file(path), project }) as unknown as TestSpecification;
    const [first = ''] = longFiles;
    const [one, two] = await new BaseSequencer(ctx).sort([
      spec('tests/support/workflows.test.mts'),
      spec('tests/coverage-thresholds.test.mts'),
    ]);
    const sorted = await new LongFilesFirst(ctx).sort(
      [two, spec(first), one].filter((entry) => entry !== undefined),
    );
    expect(sorted.map((entry) => entry.moduleId)).toEqual(
      [spec(first), one, two].map((entry) => entry?.moduleId),
    );
  });

  it('set the order of the workspace, which gives every core a worker', () => {
    expect(config.test?.sequence?.sequencer).toBe(LongFilesFirst);
    expect(config.test?.maxWorkers).toBe('100%');
  });
});
