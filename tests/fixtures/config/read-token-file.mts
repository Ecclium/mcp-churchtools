// Child process for tests/token-file.test.mts. It reads the file whose path
// the test passes with the reader of core, run from source, and prints only
// ok or the code of the refusal, never the value.
import process from 'node:process';

import { readTokenFile } from '../../../packages/core/src/config/token-file.ts';

const [path = ''] = process.argv.slice(2);
const result = readTokenFile(path, (value) => value.length);
process.stdout.write(result.ok ? 'ok\n' : `${result.code}\n`);
