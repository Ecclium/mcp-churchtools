// A module for tests/blocking-descriptors.test.mts that emits a warning
// while it loads, through the global process. Node.js writes the warning to
// process.stderr on a later tick, which makes fd 2 non-blocking then: the
// child must wait for such deferred effects before it measures.
process.emitWarning('a warning while the module loads');

export {};
