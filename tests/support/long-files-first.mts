import { relative, sep } from 'node:path';

import { BaseSequencer, type TestSpecification } from 'vitest/node';

// CI keeps no cache between runs (ADR 0021), so Vitest knows no durations
// there and starts the largest test files first. The six small files of the
// dependency cases would then start last, and the run would wait for them
// alone. So these test files start first, in this order, longest first; the
// rest keeps the order of Vitest. A run that leaves a file out, as
// coverage:security leaves out tests/architecture/, simply does not have it.
// A sequencer of its own also replaces the random order of
// --sequence.shuffle, which the workspace does not use.
export const longFiles: readonly string[] = [
  'tests/architecture/dependency-rules-1.test.mts',
  'tests/architecture/dependency-rules-2.test.mts',
  'tests/architecture/dependency-rules-3.test.mts',
  'tests/architecture/dependency-rules-4.test.mts',
  'tests/architecture/dependency-rules-5.test.mts',
  'tests/architecture/dependency-rules-6.test.mts',
  'tests/scripts/smoke.test.mts',
  'tests/scripts/smoke-write.test.mts',
  'tests/architecture/export-surface.test.mts',
  'tests/hooks/commit-hooks.test.mts',
  'tests/stdio-start.test.mts',
];

/**
 * Puts the long test files first, in the order of longFiles, and keeps the
 * order of all other files.
 *
 * @param files - The test files in the order of Vitest.
 * @param root - The root of the workspace.
 * @returns The same files in the new order.
 */
export function startLongFilesFirst<T extends { readonly moduleId: string }>(
  files: readonly T[],
  root: string,
): T[] {
  const rank = (file: T): number => {
    const index = longFiles.indexOf(
      relative(root, file.moduleId).split(sep).join('/'),
    );
    return index === -1 ? longFiles.length : index;
  };
  return files.toSorted((a, b) => rank(a) - rank(b));
}

/** The order of the test files of the workspace, set in vitest.config.mts. */
export class LongFilesFirst extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    return startLongFilesFirst(await super.sort(files), this.ctx.config.root);
  }
}
