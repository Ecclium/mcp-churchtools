// Child process for tests/mcp-stdio.test.mts. It builds the server over
// stdio from source, as a composition root does: the configuration in
// code, the example plugin of testkit in place of the plugin of the core,
// the test double of ChurchTools in place of an instance, mode
// interactive, and the line writer, logger and audit of core on the real
// fd 2. It reaches the mount only through the stdio entry of the server,
// which the test checks on this file. The test starts it with hooks.mts,
// which maps the .js imports of the packages to their source, with the
// condition @ecclium/source and with an environment of its own that keeps
// NODE_OPTIONS with the network guard.
//
// The token is a canary that the test passes in STDIO_FIXTURE_TOKEN. The
// first argument switches what the process does besides serving: «serve»
// nothing, «stray-line» writes a line of its own to stdout, «connect»
// tries a connection to a documentation address, which the network guard
// must refuse.
//
// The double answers whoami three times, in this order: with an account,
// with the status 503 and, for a call the test cancels, not before a
// minute has passed. An abort clears that wait.
import net from 'node:net';
import process from 'node:process';

import { createAuditSink } from '../../../packages/core/src/audit/index.ts';
import {
  createStdioIdentity,
  createStdioTenantResolver,
  createToolCatalog,
  createToolPipeline,
  loadConfig,
} from '../../../packages/core/src/index.ts';
import {
  createLogger,
  createStderrWriter,
} from '../../../packages/core/src/logger/index.ts';
import { startStdioServer } from '../../../packages/server/src/stdio/index.ts';
import {
  createChurchToolsDouble,
  doubleOrigin,
} from '../../../packages/testkit/src/http-double/index.ts';
import { examplePlugin } from '../../../packages/testkit/src/plugins/example/index.ts';

const [scenario = 'serve'] = process.argv.slice(2);

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: process.env['STDIO_FIXTURE_TOKEN'] ?? '',
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the fixture is invalid');
const { config } = loaded;

const clock = Object.freeze({ now: Object.freeze(() => Date.now()) });
const writer = createStderrWriter();
const logger = createLogger({ writer, clock, minLevel: config.logLevel });

const double = createChurchToolsDouble({
  token: config.churchtoolsToken,
  origin: config.churchtoolsOrigin,
  logger,
  clock,
});
const whoami = {
  path: '/api/whoami?only_allow_authenticated=true',
  method: 'GET',
} as const;
const json = { headers: { 'content-type': 'application/json' } };
const account = JSON.stringify({
  data: {
    id: 1,
    guid: '00000000-0000-0000-0000-000000000001',
    firstName: 'Max',
    lastName: 'Mustermann',
    email: 'max.mustermann@example.org',
  },
});
double.intercept(whoami).reply(200, account, json);
double.intercept(whoami).reply(503, '{}', json);
double.intercept(whoami).reply(200, account, json).delay(60_000);

const catalog = createToolCatalog({
  core: examplePlugin,
  plugins: [],
  readOnly: config.readOnly,
});
const pipeline = createToolPipeline({
  catalog,
  audit: createAuditSink({ writer, clock, isKnownTool: catalog.has }),
  transport: double.transport,
  origin: config.churchtoolsOrigin,
  requestsPerMinute: config.churchtoolsRequestsPerMinute,
  clock,
  logging: { writer, minLevel: config.logLevel },
});

startStdioServer({
  catalog,
  pipeline,
  identity: createStdioIdentity(config),
  resolver: createStdioTenantResolver(),
  mode: 'interactive',
  redaction: config.redaction,
  readOnly: config.readOnly,
  logger,
  version: '0.0.0',
});

if (scenario === 'stray-line') {
  process.stdout.write('a line that is no JSON-RPC\n');
} else if (scenario === 'connect') {
  try {
    net.connect(443, '192.0.2.1');
  } catch {
    // The guard records the attempt and fails the process at its exit.
  }
}
