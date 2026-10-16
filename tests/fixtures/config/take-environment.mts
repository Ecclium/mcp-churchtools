// Child process for tests/token-environment.test.mts. With «take» it takes
// over its own environment with the function of the command line, run
// from source, as the command line does before anything else; with «keep»
// it leaves the environment as it is. Then it starts a child of its own,
// which inherits the environment, and prints only how many variables of
// each given name that child saw, in any spelling, never a value.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { takeEnvironment } from '../../../packages/cli/src/environment.ts';

const [mode = '', ...names] = process.argv.slice(2);
if (mode === 'take') takeEnvironment(process.env, names.slice(0, 1));
const counted = spawnSync(
  process.execPath,
  [
    '-e',
    'process.stdout.write(process.argv.slice(1).map((name) => Object.keys(process.env).filter((key) => key.toUpperCase() === name).length).join(" "))',
    ...names,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
);
process.stdout.write(`${counted.stdout}\n`);
