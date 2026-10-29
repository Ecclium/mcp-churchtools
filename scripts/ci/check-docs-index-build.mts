// Builds the docs index a second time and compares it with the first build
// (ADR 0066). `pnpm ci:check` runs it right after `pnpm build`:
//
//   node scripts/ci/check-docs-index-build.mts
//
// The second build runs in a process of its own, with another time zone
// and another language, and must give the same SHA-256 as the file the
// first build wrote. A difference means the build depends on something
// other than the facts, and the index in the package would not be
// reproducible. The script loads no package of the workspace (ADR 0020):
// it starts the step of the build that `pnpm build` ran.
//
// It prints one line in German with both hashes, never a part of the file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The built file of the docs index. */
const builtFile = new URL(
  '../../packages/docs-index/dist/docs-index.json',
  import.meta.url,
);

/** The step of the build that writes it. */
const buildStep = new URL(
  '../../packages/docs-index/dist/build/main.js',
  import.meta.url,
);

/**
 * The environment of the second build: far from UTC and with a language
 * whose rules for capitals differ, so that a dependency on either shows.
 */
export const secondBuildEnvironment = Object.freeze({
  TZ: 'Pacific/Kiritimati',
  LANG: 'tr_TR.UTF-8',
  LC_ALL: 'tr_TR.UTF-8',
});

/**
 * The SHA-256 of a file's bytes, in hex.
 *
 * @param bytes - The content.
 * @returns The hash.
 */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compares two builds and describes the outcome in one line.
 *
 * @param first - The bytes of the first build.
 * @param second - The bytes of the second build.
 * @returns Whether they are equal, and the line to print.
 */
export function compareBuilds(
  first: Uint8Array,
  second: Uint8Array,
): { readonly same: boolean; readonly line: string } {
  const [a, b] = [sha256(first), sha256(second)];
  return a === b
    ? {
        same: true,
        line: `Doku-Index zweimal gebaut, gleicher SHA-256 ${a}.`,
      }
    : {
        same: false,
        line: `Doku-Index nicht reproduzierbar: erster Bau ${a}, zweiter Bau ${b}.`,
      };
}

function main(): void {
  let first: Buffer;
  try {
    first = readFileSync(builtFile);
  } catch {
    process.stderr.write(
      'Kein gebauter Doku-Index gefunden. Zuerst pnpm build ausführen.\n',
    );
    process.exitCode = 2;
    return;
  }
  const run = spawnSync(process.execPath, [fileURLToPath(buildStep)], {
    env: { ...process.env, ...secondBuildEnvironment },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (run.status !== 0) {
    process.stderr.write('Der zweite Bau des Doku-Index ist gescheitert.\n');
    process.exitCode = 1;
    return;
  }
  const { same, line } = compareBuilds(first, readFileSync(builtFile));
  process.stdout.write(`${line}\n`);
  process.exitCode = same ? 0 : 1;
}

if (import.meta.main) {
  main();
}
