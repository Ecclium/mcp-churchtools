// Preload for the child process of tests/stdio-start.test.mts, loaded with
// --import after the resolution hook of the packages. It records every
// built-in module that the process imports as an ES module, with the
// condition import, and writes the list as JSON to the file that the test
// names in START_FIXTURE_RECORD when the process exits. A require() of a
// built-in, as undici does it, carries the condition require instead and
// is left out, because the test asks only whether the ES module of
// node:util loads, which makes fd 2 non-blocking (ADR 0054).
import { writeFileSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import process from 'node:process';

const record = process.env['START_FIXTURE_RECORD'] ?? '';
const imported = new Set<string>();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier) && context.conditions.includes('import')) {
      imported.add(specifier);
    }
    return nextResolve(specifier, context);
  },
});

process.once('exit', () => {
  writeFileSync(record, JSON.stringify([...imported]));
});
