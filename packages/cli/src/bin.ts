#!/usr/bin/env node
/**
 * The executable of the command line, `ecclium`. It is the only module in
 * the packages that may read the environment, the arguments and the
 * options of Node.js (ADR 0055). Before anything else it takes the token
 * out of `process.env`, in every spelling of its name, so that no module
 * loaded after it and no child process sees the token. Only then does it
 * load what the call asks for, with `import()`:
 * `ecclium stdio` loads the start over stdio, every other call the command
 * line in `main.ts`. So the start over stdio never loads `main.ts`, whose
 * `node:util` makes fd 2 non-blocking before the start notices go out
 * (ADR 0054). Two rules of dependency-cruiser keep these imports as they
 * are. There is no guard such as `import.meta.main`: in a bundle that
 * imports this code, a guard would turn the command into a silent exit
 * with 0.
 *
 * @packageDocumentation
 */
import { takeEnvironment } from './environment.js';

// The name of the token is a literal, because this module imports nothing
// else before the token is gone; bin.test.ts checks it against
// tokenVariableName. A takeover that fails, which process.env never
// causes, gives undefined.
const environment = ((): Readonly<Record<string, string>> | undefined => {
  try {
    return takeEnvironment(process.env, ['ECCLIUM_CHURCHTOOLS_TOKEN']);
  } catch {
    return undefined;
  }
})();

if (environment === undefined) {
  // 70 is the internal error of exit-codes.ts, which bin.test.ts checks.
  // There is no text: nothing here may write to stderr.
  process.exitCode = 70;
} else if (process.argv[2] === 'stdio') {
  const { startStdio } = await import('./stdio/index.js');
  // undefined means the server runs: it sets the exit code itself when the
  // connection ends. Both calls get the options of Node.js, so that the
  // start and `ecclium config check` report the same settings of TLS.
  const code = await startStdio(
    process.argv.slice(3),
    environment,
    process.execArgv,
  );
  if (code !== undefined) process.exitCode = code;
} else {
  const { run } = await import('./main.js');
  process.exitCode = run(process.argv.slice(2), environment, process.execArgv);
}
