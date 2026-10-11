// Vitest setup file: installs the network guard in every test process and
// fails every test during which the code tried to reach the network, also
// when it caught the error (ADR 0052).
import process from 'node:process';
import { afterAll, afterEach, beforeEach } from 'vitest';

import {
  assertNoNetworkUse,
  blockedMarker,
  guardPreload,
  installNetworkGuard,
  loopbackProxyActive,
  NetworkBlockedError,
  proxyVariables,
} from './no-network.mts';

const guard = installNetworkGuard();
guard.state.vitest = true;

// A proxy on a loopback address that Node.js already follows would pass the
// guard and carry every request out, so the run stops before the first test.
const flags = `${process.env['NODE_OPTIONS'] ?? ''} ${process.execArgv.join(' ')}`;
if (loopbackProxyActive(process.env, flags)) {
  throw new NetworkBlockedError(
    'NODE_USE_ENV_PROXY oder --use-env-proxy mit einem Proxy auf Loopback',
  );
}
// Tests need no proxy. A test that wants one for a child process sets it in
// the environment of that child.
for (const name of [...proxyVariables, 'NODE_USE_ENV_PROXY']) {
  Reflect.deleteProperty(process.env, name);
}

// Node.js child processes load the guard too. Programs that are not Node.js
// (git, gitleaks) are covered only by the network namespace in CI.
const options = process.env['NODE_OPTIONS'] ?? '';
if (!options.split(/\s+/).includes(guardPreload)) {
  process.env['NODE_OPTIONS'] = `${options} ${guardPreload}`.trim();
}

// Attempts of this test file, also those that a hook could not attach to a
// test: in a test marked as failing, or after the hooks of the last test.
const firstOfFile = guard.log.length;

// The setup file registers first, so its beforeEach runs before and its
// afterEach after the hooks of the test file. An attempt outside this span
// is reported as an uncaught error (see record() in no-network.mts).
beforeEach(() => {
  guard.state.inTest = true;
});

afterEach(() => {
  guard.state.inTest = false;
  assertNoNetworkUse(guard);
});

afterAll(() => {
  const attempts = guard.log.slice(firstOfFile);
  // Reported below together with every other attempt of the file; what is
  // left to check is that every patch is still in place.
  guard.violations.splice(0);
  assertNoNetworkUse(guard);
  if (attempts.length > 0) {
    throw new Error(
      `${blockedMarker}: ${String(attempts.length)} Versuche in dieser Datei, auch abgefangene und solche, die keinem Test zuzuordnen waren:\n${attempts.join('\n')}`,
    );
  }
});
