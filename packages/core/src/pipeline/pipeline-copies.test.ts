import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type {
  Plugin,
  PluginHost,
  TenantAssignment,
  TenantContext,
  ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline } from './pipeline.js';

// The real context is frozen, so a test against it proves nothing about
// copies. This file replaces the factory with one that hands out an
// unfrozen copy, which a tool can change.
vi.mock('../tenant/context.js', async (original) => {
  const real = await original<typeof import('../tenant/context.js')>();
  return {
    ...real,
    createTenantContext: (
      options: Parameters<typeof real.createTenantContext>[0],
    ): TenantContext => ({ ...real.createTenantContext(options) }),
  };
});

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('the pipeline before execute', () => {
  it('works with its own copies, whatever the tool changes in the context', async () => {
    const changing = {
      name: 'ct_changes',
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
        purpose: 'Changes its context.',
        useWhen: 'A test needs it.',
        avoidWhen: 'Anything else.',
        limits: 'None.',
      },
      input: z.object({}),
      output: z.object({ frozen: z.boolean() }),
      execute: ({ ctx }: { ctx: Record<string, unknown> }) => {
        const frozen = Object.isFrozen(ctx);
        ctx.mode = 'operator';
        ctx.readOnly = false;
        ctx.redaction = 'off';
        ctx.features = ['pro'];
        return Promise.resolve({ frozen });
      },
    } as unknown as ToolDefinition;
    const plugin: Plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      register(host: PluginHost): undefined {
        host.addTool(changing);
        return undefined;
      },
    };
    const double = createChurchToolsDouble({
      token: loaded.config.churchtoolsToken,
    });
    open.push(double);
    const catalog = createToolCatalog({ plugins: [plugin], readOnly: true });
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
      logging: { writer, minLevel: 'info' },
    });
    const outcome = await pipeline.call(
      'ct_changes',
      {},
      {
        assignment: {
          tenantId: 'default',
          actor: { kind: 'user', id: 'stdio:local-stdio' },
        } as unknown as TenantAssignment,
        mode: 'interactive',
        redaction: 'standard',
        readOnly: true,
        features: [],
        signal: new AbortController().signal,
      },
    );
    // The double really was unfrozen, so the test would see a change.
    expect(outcome).toEqual({ ok: true, data: { frozen: false } });
    const event = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === 'tool_call');
    expect(event).toMatchObject({ mode: 'interactive', outcome: 'ok' });
  });
});
