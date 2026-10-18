import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  EccliumError,
  type Plugin,
  type TenantAssignment,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  assertNoCanary,
  assertPlanted,
  createChurchToolsDouble,
  doubleOrigin,
  examplePlugin,
  makeCanaries,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// Canaries in the token, in the input and in answers of ChurchTools must
// never reach audit or log, and reach the result only where a tool returns
// them on purpose, and then masked where their class has a mask. Tokens and values are made at run time; requests go
// through the real transport on the ChurchTools double.

const canary = makeCanaries();
const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const whoamiPath = '/api/whoami?only_allow_authenticated=true';
const json = { headers: { 'content-type': 'application/json' } };

const request = (): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

// A tool that fails with contact data in its message, as a careless tool
// might. A plain object, not defineTool: core and the plugin interface
// resolve different copies of zod in the workspace.
const failingPlugin: Plugin = {
  name: 'failing-plugin',
  version: '1.0.0',
  register(host): undefined {
    host.addTool({
      name: 'ct_test_fails',
      meta: {
        capability: 'read',
        domain: 'base',
        requiredRights: [],
        tier: 'free',
        sensitivity: 'none',
        unattended: 'policy',
        routineStable: false,
      },
      description: {
        purpose: 'Serves a test.',
        useWhen: 'A test needs it.',
        avoidWhen: 'Anything else.',
        limits: 'None.',
      },
      input: z.object({}),
      output: z.object({}),
      execute: () =>
        Promise.reject(
          new EccliumError(
            'not_found',
            `No person ${canary.email.value} with ${canary.phone.value}.`,
          ),
        ),
    } as unknown as ToolDefinition);
    return undefined;
  },
};

const setup = () => {
  const double = createChurchToolsDouble({
    token: loaded.config.churchtoolsToken,
  });
  open.push(double);
  const catalog = createToolCatalog({
    plugins: [examplePlugin, failingPlugin],
    readOnly: true,
  });
  const lines: string[] = [];
  const writer = Object.freeze({
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  });
  const clock = Object.freeze({ now: Object.freeze(() => 0) });
  const pipeline = createToolPipeline({
    catalog,
    audit: createAuditSink({ writer, clock, isKnownTool: catalog.has }),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
  });
  return { double, pipeline, lines };
};

describe('canaries', () => {
  it('leave the token out of result, audit and log of a reading call', async () => {
    const { double, pipeline, lines } = setup();
    double.intercept({ path: whoamiPath, method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: {
          id: 7,
          guid: '00000000-0000-0000-0000-000000000007',
          firstName: 'Person',
          lastName: 'A',
          email: canary.email.value,
        },
      }),
      json,
    );
    const outcome = await pipeline.call('ct_example_profile', {}, request());
    // The token reached ChurchTools, so the check below proves something.
    assertPlanted(double.calls(), [canary.token], 'request');
    expect(outcome.ok).toBe(true);
    assertNoCanary([outcome, lines], [canary.token], 'call');
    // The address the tool returns on purpose reaches the result masked
    // and stays out of audit and log.
    assertNoCanary(outcome, [canary.email], 'result');
    expect(outcome.ok && outcome.data.email).toBe(
      `${canary.email.value.charAt(0)}***@example.org`,
    );
    assertNoCanary(lines, canary.all, 'audit and log');
  });

  it('leave the values of an error body out of outcome, audit and log', async () => {
    const { double, pipeline, lines } = setup();
    const body = {
      message: canary.token.value,
      translatedMessage: canary.email.value,
      args: [canary.name.value],
      errors: [{ value: canary.phone.value }],
    };
    assertPlanted(body, canary.all, 'error body');
    double
      .intercept({ path: whoamiPath, method: 'GET' })
      .reply(403, JSON.stringify(body), json);
    const outcome = await pipeline.call('ct_example_profile', {}, request());
    expect(!outcome.ok && outcome.error.code).toBe('permission');
    assertNoCanary([outcome, lines], canary.all, 'call');
  });

  it('leave a refused input out of outcome, audit and log', async () => {
    const { pipeline, lines } = setup();
    const input = {
      email: canary.email.value,
      [canary.name.value]: canary.phone.value,
    };
    assertPlanted(input, [canary.email, canary.phone], 'input');
    const outcome = await pipeline.call('ct_example_echo', input, request());
    expect(!outcome.ok && outcome.error.code).toBe('validation');
    assertNoCanary([outcome, lines], canary.all, 'call');
  });

  it('leave an accepted input out of audit and log', async () => {
    const { pipeline, lines } = setup();
    const outcome = await pipeline.call(
      'ct_example_echo',
      {
        email: canary.email.value,
        phone: canary.phone.value,
        notes: [canary.name.value],
      },
      request(),
    );
    // Free text reaches the result in its envelope, contact data masked.
    assertPlanted(outcome, [canary.name], 'result');
    assertNoCanary(outcome, [canary.email, canary.phone], 'result');
    assertNoCanary(lines, canary.all, 'audit and log');
  });

  it('leave contact data in the message of a failed call out of the outcome', async () => {
    const { pipeline, lines } = setup();
    const outcome = await pipeline.call('ct_test_fails', {}, request());
    expect(!outcome.ok && outcome.error.code).toBe('not_found');
    expect(!outcome.ok && outcome.error.message).toContain('***@example.org');
    assertNoCanary([outcome, lines], canary.all, 'call');
  });
});
