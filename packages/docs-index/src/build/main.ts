/**
 * The step of `pnpm build` that writes the docs index (ADR 0066). The
 * root script runs it after `tsc -b` as
 * `node packages/docs-index/dist/build/main.js`. It prints nothing; a
 * check that fails ends the build with its error, which names files,
 * fields and rules but never a value.
 *
 * It lies in the package, not under `scripts/`, because scripts load no
 * package of the workspace (ADR 0020). Nothing imports it.
 *
 * @packageDocumentation
 */
import { writeDocsIndex } from './files.js';

writeDocsIndex();
