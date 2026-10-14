// Child process for tests/logger-output.test.mts. It writes three lines
// through the stderr writer of core onto the real fd 2, which the parent
// connects to a pipe or to a file. Only the real writeSync shows how its
// arguments land: a position, even 0, would fail on a pipe and write over
// the start of a file. The writer is imported on its own, because it is the
// one module of the logger without relative imports, which Node.js could
// not resolve from source.
import { createStderrWriter } from '../../../packages/core/src/logger/line-writer.ts';

const writer = createStderrWriter();
writer.write('{"level":"info","event":"first","count":1}');
writer.write('{"level":"warn","event":"second","count":2}');
writer.write('{"level":"error","event":"third","count":3}');
