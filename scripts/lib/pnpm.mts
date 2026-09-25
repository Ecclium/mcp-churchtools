/**
 * Runs pnpm from the scripts under scripts/.
 *
 * @packageDocumentation
 */
import { execFileSync } from 'node:child_process';

/**
 * Runs pnpm with the given arguments and returns its standard output.
 *
 * Inside `pnpm run`, pnpm names its own executable in `npm_execpath`, so the
 * same pnpm runs again, never another one from the search path. A JavaScript
 * entry point is started with the running Node.js.
 *
 * @param args - Arguments for pnpm, such as `['config', 'list', '--json']`.
 * @param env - Environment for pnpm, by default that of this process.
 * @returns The standard output of pnpm.
 * @throws {Error} If pnpm cannot be started or exits with an error.
 */
export function runPnpm(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const execPath = process.env['npm_execpath'];
  const [command, prefix] =
    execPath === undefined
      ? ['pnpm', []]
      : /\.[cm]?js$/.test(execPath)
        ? [process.execPath, [execPath]]
        : [execPath, []];
  return execFileSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
