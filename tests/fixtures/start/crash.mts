// Preload for the child process of tests/stdio-start.test.mts, loaded with
// --import. On SIGUSR2 it lets an error that nothing catches loose in the
// running server: its message and its cause hold a canary that the test
// passes in START_FIXTURE_CANARY. The query of the import says how:
// «?throw» throws it, «?reject» rejects a promise with it that nothing
// handles, and «?bare» first removes the handlers of the start and then
// throws it, as a control that Node.js itself would print the canary.
import process from 'node:process';

const how = new URL(import.meta.url).search.slice(1);
const canary = process.env['START_FIXTURE_CANARY'] ?? '';

process.on('SIGUSR2', () => {
  const error = new Error(`crash ${canary}`, {
    cause: new Error(`cause ${canary}`),
  });
  if (how === 'reject') {
    void Promise.reject(error);
    return;
  }
  if (how === 'bare') {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  }
  throw error;
});
