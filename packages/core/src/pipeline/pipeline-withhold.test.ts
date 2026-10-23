import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  type Plugin,
  type PluginHost,
  type TenantAssignment,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type AuditDraft,
  type AuditSink,
  createAuditSink,
  type RecordOptions,
} from '../audit/index.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// A tool with sensitivity special gives its result only when its line is
// in the audit file, and runs only when the file can take a line
// (ADR 0028). Tools with sensitivity none or personal stay as they were.
// The audit file is a target in memory whose answers a test sets.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

type Sensitivity = 'none' | 'personal' | 'special';

const runs: string[] = [];

// A plain tool of the test that counts its runs. A tool with sensitivity
// special must never run unattended, which the registry checks.
const tool = (name: `ct_${string}`, sensitivity: Sensitivity): ToolDefinition =>
  ({
    name,
    meta: {
      capability: 'read',
      domain: 'base',
      requiredRights: [],
      tier: 'free',
      sensitivity,
      unattended: sensitivity === 'special' ? 'never' : 'policy',
      routineStable: false,
    },
    description,
    input: z.strictObject({ query: z.string().max(10) }),
    output: z.object({ text: classify(z.string(), 'none') }),
    execute: () => {
      runs.push(name);
      return Promise.resolve({ text: 'found' });
    },
  }) as unknown as ToolDefinition;

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    host.addTool(tool('ct_test_special', 'special'));
    host.addTool(tool('ct_test_personal', 'personal'));
    host.addTool(tool('ct_test_none', 'none'));
    return undefined;
  },
};

const request: ToolRequest = {
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction: 'standard',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
};

interface FileState {
  /** What write of the file answers. */
  write: () => boolean;
  /** What ready of the file answers. */
  ready: () => boolean;
}

interface Setup {
  readonly file: FileState;
  readonly call: (
    name: string,
    input?: unknown,
  ) => ReturnType<ReturnType<typeof createToolPipeline>['call']>;
  /** Audit lines in the file, parsed. */
  readonly inFile: () => Record<string, unknown>[];
  /** Copies of audit lines on stderr, parsed. */
  readonly copies: () => Record<string, unknown>[];
  /** The events of the log lines. */
  readonly logs: () => { event: string; code?: string }[];
}

const setup = (
  options: {
    readonly withFile?: boolean;
    readonly audit?: AuditSink;
    readonly sinkClock?: { readonly now: () => number };
  } = {},
): Setup => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: true,
  });
  const fileLines: string[] = [];
  const stderr: string[] = [];
  const file: FileState = { write: () => true, ready: () => true };
  const clock = Object.freeze({ now: Object.freeze(() => 1_000) });
  const audit =
    options.audit ??
    createAuditSink({
      writer: {
        write: (line) => {
          stderr.push(line);
          return true;
        },
      },
      ...(options.withFile === false
        ? {}
        : {
            file: {
              write: (line: string) => {
                const taken = file.write();
                if (taken) fileLines.push(line);
                return taken;
              },
              ready: () => file.ready(),
            },
          }),
      clock: options.sinkClock ?? clock,
      isKnownTool: catalog.has,
    });
  const pipeline = createToolPipeline({
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: {
      writer: Object.freeze({
        write: (line: string) => {
          stderr.push(line);
          return true;
        },
      }),
      minLevel: 'debug',
    },
  });
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    file,
    call: (name, input = { query: 'a' }) => pipeline.call(name, input, request),
    inFile: () => fileLines.map(parse),
    copies: () =>
      stderr.filter((line) => line.startsWith('{"v":1,')).map(parse),
    logs: () =>
      stderr
        .filter((line) => !line.startsWith('{"v":1,'))
        .map((line) => JSON.parse(line) as { event: string; code?: string }),
  };
};

afterEach(() => {
  runs.length = 0;
});

describe('a tool with sensitivity special', () => {
  it('gives its result when its line is in the audit file', async () => {
    const { call, inFile, copies } = setup();
    const outcome = await call('ct_test_special');
    expect(outcome.ok).toBe(true);
    expect(inFile()).toMatchObject([
      { tool: 'ct_test_special', outcome: 'ok' },
    ]);
    expect(copies()).toMatchObject([{ outcome: 'ok' }]);
  });

  it('holds its result back when the file does not take its line', async () => {
    const { file, call, inFile, copies, logs } = setup();
    file.write = () => false;
    const outcome = await call('ct_test_special');
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'policy_denied',
        message:
          'The call could not be recorded in the audit file, so its result is held back. Ask the operator to check the audit file.',
      },
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    // It ran and read; only its result stays back.
    expect(runs).toEqual(['ct_test_special']);
    expect(inFile()).toEqual([]);
    expect(copies()).toMatchObject([
      { outcome: 'denied', errorCode: 'policy_denied' },
    ]);
    expect(logs().map(({ event, code }) => [event, code])).toEqual([
      ['audit_withheld', 'policy_denied'],
      ['tool_call', 'policy_denied'],
    ]);
  });

  it('holds its result back when the clock of the audit fails', async () => {
    const { call, inFile } = setup({
      sinkClock: {
        now: () => {
          throw new Error('clock');
        },
      },
    });
    expect(await call('ct_test_special')).toMatchObject({
      ok: false,
      error: { code: 'policy_denied' },
    });
    expect(inFile()).toMatchObject([
      { outcome: 'denied', errorCode: 'policy_denied' },
    ]);
  });

  it('does not run when the file cannot take a line, not even its input is checked', async () => {
    const { file, call, inFile, copies } = setup();
    file.ready = () => false;
    for (const input of [{ query: 'a' }, { query: 'far too long' }, 'x']) {
      expect(await call('ct_test_special', input)).toEqual({
        ok: false,
        error: {
          code: 'policy_denied',
          message:
            'The audit file of the server cannot record this call now, so the tool did not run. Ask the operator to check the audit file.',
        },
      });
    }
    expect(runs).toEqual([]);
    // The refusal itself is audited like any other.
    expect(inFile()).toHaveLength(3);
    expect(copies()).toHaveLength(3);
  });

  it('does not run without an audit file', async () => {
    const { call } = setup({ withFile: false });
    expect(await call('ct_test_special')).toMatchObject({
      ok: false,
      error: { code: 'policy_denied' },
    });
    expect(runs).toEqual([]);
  });

  it('does not run when ready of the sink throws', async () => {
    const { call } = setup({
      audit: {
        record: () => true,
        hasFile: true,
        ready: () => {
          throw new Error('ready');
        },
        failures: () => 0,
      },
    });
    expect(await call('ct_test_special')).toMatchObject({
      ok: false,
      error: { code: 'policy_denied' },
    });
    expect(runs).toEqual([]);
  });

  it.each([
    [
      'throws',
      (): boolean => {
        throw new Error('record');
      },
    ],
    ['answers with no boolean', () => 1 as unknown as boolean],
  ])('holds its result back when record %s', async (_name, record) => {
    const { call } = setup({
      audit: { record, hasFile: true, ready: () => true, failures: () => 0 },
    });
    expect(await call('ct_test_special')).toMatchObject({
      ok: false,
      error: { code: 'policy_denied' },
    });
    expect(runs).toEqual(['ct_test_special']);
  });

  it('keeps an error as it is when the file does not take its line', async () => {
    const { file, call } = setup();
    file.write = () => false;
    expect(
      await call('ct_test_special', { query: 'far too long' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
  });
});

describe('the options of record', () => {
  const recording = () => {
    const calls: { tool: unknown; options: RecordOptions | undefined }[] = [];
    const audit: AuditSink = {
      record: (draft: AuditDraft, _id?: string, options?: RecordOptions) => {
        calls.push({ tool: draft.tool, options });
        return true;
      },
      hasFile: true,
      ready: () => true,
      failures: () => 0,
    };
    return { calls, audit };
  };

  it('ask for the line only for an ok result of a tool with sensitivity special', async () => {
    const { calls, audit } = recording();
    const { call } = setup({ audit });
    await call('ct_test_special');
    await call('ct_test_special', { query: 'far too long' });
    await call('ct_test_personal');
    await call('ct_test_none');
    await call('ct_not_there');
    expect(calls).toEqual([
      { tool: 'ct_test_special', options: { required: true } },
      { tool: 'ct_test_special', options: { required: false } },
      { tool: 'ct_test_personal', options: { required: false } },
      { tool: 'ct_test_none', options: { required: false } },
      { tool: 'ct_unknown', options: { required: false } },
    ]);
  });
});

describe('tools with sensitivity none or personal', () => {
  it.each(['ct_test_personal', 'ct_test_none'])(
    '%s gives its result even when the file takes no line and is not ready',
    async (name) => {
      const { file, call, copies, logs } = setup();
      file.write = () => false;
      file.ready = () => false;
      expect(await call(name)).toMatchObject({ ok: true });
      expect(runs).toEqual([name]);
      expect(copies()).toMatchObject([{ outcome: 'ok' }]);
      expect(logs().map(({ event }) => event)).toEqual(['tool_call']);
    },
  );

  it('give their result when the clock of the audit fails', async () => {
    const { call } = setup({
      sinkClock: {
        now: () => {
          throw new Error('clock');
        },
      },
    });
    expect(await call('ct_test_personal')).toMatchObject({ ok: true });
  });
});
