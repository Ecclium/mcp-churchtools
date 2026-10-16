#!/usr/bin/env node
/**
 * The executable of the command line, `ecclium`. It is the only module in
 * the packages that may read the environment (ADR 0055): it hands
 * `process.env` and the arguments to `run`, which takes the token out of
 * the environment before anything else, and sets the exit code. There is
 * no guard such as `import.meta.main`: in a bundle that imports this code,
 * a guard would turn the command into a silent exit with 0.
 *
 * @packageDocumentation
 */
import { run } from './main.js';

process.exitCode = run(process.argv.slice(2), process.env);
