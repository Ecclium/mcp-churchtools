import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServerFactory,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  serveStdio,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditSink } from '../audit/index.js';
import type { WriteConfirmation } from '../config/index.js';
import {
  createStdioIdentity,
  createStdioTenantResolver,
} from '../identity/index.js';
import { createLogger } from '../logger/index.js';
import { createToolPipeline } from '../pipeline/index.js';
import { defaultPolicy } from '../policy/check.js';
import type { Policy } from '../policy/schema.js';
import { canonicalOfWritten } from '../content/index.js';
import { KeyMaterial } from '../keys/index.js';
import { checkCodeOf, markingLineOf } from '../marker/index.js';
import { createToolCatalog } from '../registry/index.js';
import {
  confirmationSentence,
  confirmationSentences,
} from '../write/confirm.js';
import { createMemoryNonceStore } from '../write/nonce-store.js';
import { createMemoryPlanStore } from '../write/plan-store.js';
import { createMcpMount } from './mount.js';

// The question before a write, end to end in process: the test plays the
// client in raw JSON-RPC against the serving entry of the SDK, the mount
// turns the question of the pipeline into input_required, and the write
// guard writes to the double of ChurchTools (ADR 0029, ADR 0053). Both
// eras: the 2026 era answers through the client, the 2025 era through the
// shim of the SDK.

type Json = Readonly<Record<string, unknown>>;

// The key of the check codes and whom to ask, which a write that adds a
// page or a section to the wiki needs (ADR 0032).
const markerKey = new KeyMaterial('0123456789abcdef'.repeat(4));
const marking = (policy: Policy): Policy =>
  policy.interactive.inquiriesTo === undefined
    ? Object.freeze({
        ...policy,
        interactive: Object.freeze({
          ...policy.interactive,
          inquiriesTo: 'Sekretariat',
        }),
      })
    : policy;

// A section as the write guard adds it: the written text and its line of
// the marking, interactive, of the day of the test (ADR 0032).
const marked = (written: string): string => {
  const day = '2026-11-03' as IsoDate;
  const origin = { kind: 'interactive', day } as const;
  const code = checkCodeOf(
    markerKey,
    'default',
    origin,
    canonicalOfWritten(written),
  );
  return `${written}\n${markingLineOf({ date: day, origin, code }, 'Sekretariat')}\n`;
};

const at = (value: unknown, ...path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Readonly<Record<string | number, unknown>>)[key]
        : undefined,
    value,
  );

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const now = Date.UTC(2026, 10, 3, 12, 0, 0);
const clock = Object.freeze({ now: Object.freeze(() => now) });
const guid = '00000000-0000-4000-8000-0000000000ab';
const pagePath = `/api/wiki/categories/12/pages/${guid}`;
const json = {
  headers: {
    'content-type': 'application/json',
    date: new Date(now).toUTCString(),
  },
};
const rights = JSON.stringify({
  data: { churchwiki: { 'edit category': [12] } },
});
const page = (version: number, text: string): string =>
  JSON.stringify({
    data: { title: 'Dienstplan', isMarkdown: true, version, text },
  });
const note = { categoryId: 12, guid, baseVersion: 3, note: 'Hallo' };
const key = new Uint8Array(32).fill(7);

let dir: string;
const open: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecclium-mount-confirm-'));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const setup = (
  options: {
    readonly requestStateKey?: Uint8Array | null;
    readonly confirmation?: WriteConfirmation;
  } = {},
) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [],
    readOnly: false,
    toolsets: new Set(['wiki'] as const),
  });
  const auditLines: string[] = [];
  const write = (line: string): boolean => {
    auditLines.push(line);
    return true;
  };
  const pipeline = createToolPipeline({
    policy: marking(defaultPolicy),
    markerKey,
    catalog,
    audit: createAuditSink({
      writer: { write: () => true },
      file: { write, ready: () => true, anchor: () => undefined },
      clock,
      isKnownTool: catalog.has,
    }),
    quota: createMemoryQuotaStore(),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer: { write: () => true }, minLevel: 'debug' },
    killSwitchDir: dir,
    plans: createMemoryPlanStore(clock),
    nonces: createMemoryNonceStore(clock),
    ...(options.confirmation === undefined
      ? {}
      : { confirmation: options.confirmation }),
  });
  const mount = createMcpMount({
    catalog,
    pipeline,
    identity: createStdioIdentity({
      stdioSubject: 'local-stdio',
      readOnly: false,
    }),
    resolver: createStdioTenantResolver(),
    mode: 'interactive',
    redaction: 'standard',
    readOnly: false,
    logger: createLogger({
      writer: { write: () => true },
      clock,
      minLevel: 'debug',
      prompts: new Set(),
    }),
    version: '0.0.0',
    ...(options.requestStateKey === null
      ? {}
      : { requestStateKey: options.requestStateKey ?? key }),
  });
  // The reads of the plan: the rights, then the page.
  const planReads = () => {
    double
      .intercept({ path: '/api/permissions/global', method: 'GET' })
      .reply(200, rights, json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
  };
  // The read right before the write, the write and the read after it.
  const commitReads = () => {
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(3, '# Plan\n'), json);
    double
      .intercept({ path: pagePath, method: 'PATCH' })
      .reply(200, '{}', json);
    double
      .intercept({ path: pagePath, method: 'GET' })
      .reply(200, page(4, `# Plan\n\n${marked('Hallo\n')}`), json);
  };
  const sent = () =>
    double.calls().filter(({ method }) => method !== 'GET').length;
  const audit = () => auditLines.map((line) => JSON.parse(line) as Json);
  return { factory: mount.factory, planReads, commitReads, sent, audit };
};

/** What the client answers to a request of the server. */
type Answer = (message: Json) => Json;

const connect = async (factory: McpServerFactory, answer?: Answer) => {
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Json) => void>();
  const asked: Json[] = [];
  let lastId = 0;
  client.onmessage = (raw) => {
    const message = JSON.parse(JSON.stringify(raw)) as Json;
    const id = message['id'];
    if (typeof message['method'] === 'string' && id !== undefined) {
      // A request of the server: only the shim sends one, to ask.
      asked.push(message);
      void client.send({
        jsonrpc: '2.0',
        id,
        result: answer?.(message) ?? { action: 'cancel' },
      } as unknown as JSONRPCMessage);
    } else if (typeof id === 'number') {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  const handle: StdioServerHandle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
  });
  open.push(handle);
  const request = async (method: string, params: Json): Promise<Json> => {
    lastId += 1;
    const id = lastId;
    const reply = new Promise<Json>((resolve) => pending.set(id, resolve));
    await client.send({
      jsonrpc: '2.0',
      id,
      method,
      params,
    } as unknown as JSONRPCMessage);
    return reply;
  };
  const notify = (method: string): Promise<void> =>
    client.send({ jsonrpc: '2.0', method } as unknown as JSONRPCMessage);
  return { request, notify, asked };
};

const modernMeta = (capabilities: unknown): Json => ({
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: capabilities,
});

const answerWith = (action: string, content?: Json): Json => ({
  bestaetigung: content === undefined ? { action } : { action, content },
});

describe('a question before a write in the 2026 era', () => {
  const call = (
    connection: Awaited<ReturnType<typeof connect>>,
    extra: Json = {},
    capabilities: unknown = { elicitation: {} },
  ): Promise<Json> =>
    connection.request('tools/call', {
      name: 'ct_example_note_write',
      arguments: note,
      _meta: modernMeta(capabilities),
      ...extra,
    });

  it('asks in form mode with summary and diff, and writes after a yes', async () => {
    const { factory, planReads, commitReads, sent, audit } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    expect(at(first, 'result', 'resultType')).toBe('input_required');
    const question = at(first, 'result', 'inputRequests', 'bestaetigung');
    expect(at(question, 'method')).toBe('elicitation/create');
    expect(at(question, 'params', 'mode')).toBe('form');
    expect(at(question, 'params', 'message')).toContain(
      'An die Seite «Dienstplan» in der Kategorie 12 einen Abschnitt mit 4 Zeilen anhängen.',
    );
    expect(at(question, 'params', 'requestedSchema', 'required')).toEqual([
      'bestaetigen',
    ]);
    const requestState = at(first, 'result', 'requestState');
    expect(typeof requestState).toBe('string');
    expect(sent()).toBe(0);

    commitReads();
    const second = await call(connection, {
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState,
    });
    expect(at(second, 'result', 'isError')).toBeUndefined();
    expect(at(second, 'result', 'structuredContent')).toMatchObject({
      state: 'verified',
      version: 4,
    });
    expect(sent()).toBe(1);
    expect(audit().map((event) => event['writeState'])).toEqual([
      'planned',
      'verified',
    ]);
    expect(audit()[1]).toMatchObject({ confirmation: 'elicitation' });
  });

  it.each([
    ['a decline', answerWith('decline')],
    ['a cancel', answerWith('cancel')],
    ['a no', answerWith('accept', { bestaetigen: false })],
    ['content outside the form', answerWith('accept', { bestaetigen: 'ja' })],
    ['no answer', {}],
  ])('writes nothing after %s', async (_name, inputResponses) => {
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    const second = await call(connection, {
      inputResponses,
      requestState: at(first, 'result', 'requestState'),
    });
    expect(at(second, 'result', 'isError')).toBe(true);
    expect(at(second, 'result', 'content', 0, 'text')).toBe(
      confirmationSentences.notConfirmed,
    );
    expect(sent()).toBe(0);
  });

  it.each([{}, { elicitation: { url: {} } }, { sampling: {} }])(
    'asks no client that declares %j',
    async (capabilities) => {
      const { factory, planReads, sent } = setup();
      planReads();
      const connection = await connect(factory);
      const reply = await call(connection, {}, capabilities);
      expect(at(reply, 'result', 'resultType')).toBe('complete');
      expect(at(reply, 'result', 'content', 0, 'text')).toBe(
        confirmationSentence,
      );
      expect(sent()).toBe(0);
    },
  );

  it('asks nothing with the setting queue, even a client that can', async () => {
    const { factory, planReads } = setup({ confirmation: 'queue' });
    planReads();
    const connection = await connect(factory);
    const reply = await call(connection);
    expect(at(reply, 'result', 'resultType')).toBe('complete');
    expect(at(reply, 'result', 'isError')).toBe(true);
  });

  it('refuses a forged requestState before the handler', async () => {
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    const state = String(at(first, 'result', 'requestState'));
    const reply = await call(connection, {
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState: `${state.slice(0, -4)}AAAA`,
    });
    expect(at(reply, 'error', 'code')).toBe(-32602);
    expect(at(reply, 'error', 'data', 'reason')).toBe('invalid_request_state');
    expect(sent()).toBe(0);
  });

  it('refuses a requestState of another process, as after a restart', async () => {
    const before = setup();
    before.planReads();
    const first = await call(await connect(before.factory));
    // A new process draws a new key.
    const after = setup({ requestStateKey: new Uint8Array(32).fill(8) });
    const reply = await call(await connect(after.factory), {
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState: at(first, 'result', 'requestState'),
    });
    expect(at(reply, 'error', 'code')).toBe(-32602);
    expect(after.sent()).toBe(0);
  });

  it('refuses a requestState after 600 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    vi.setSystemTime(now + 601_000);
    const reply = await call(connection, {
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState: at(first, 'result', 'requestState'),
    });
    expect(at(reply, 'error', 'code')).toBe(-32602);
    expect(sent()).toBe(0);
  });

  it('writes once for a requestState sent twice', async () => {
    const { factory, planReads, commitReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    commitReads();
    const answer = {
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState: at(first, 'result', 'requestState'),
    };
    await call(connection, answer);
    const again = await call(connection, answer);
    expect(at(again, 'result', 'content', 0, 'text')).toBe(
      confirmationSentences.used,
    );
    expect(sent()).toBe(1);
  });

  it('refuses an answer that comes with other arguments', async () => {
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    const first = await call(connection);
    const reply = await connection.request('tools/call', {
      name: 'ct_example_note_write',
      arguments: { ...note, note: 'Anders' },
      _meta: modernMeta({ elicitation: {} }),
      inputResponses: answerWith('accept', { bestaetigen: true }),
      requestState: at(first, 'result', 'requestState'),
    });
    expect(at(reply, 'result', 'content', 0, 'text')).toBe(
      confirmationSentences.notThisCall,
    );
    expect(sent()).toBe(0);
  });

  it('asks nothing without the key of the requestState', async () => {
    const { factory, planReads } = setup({ requestStateKey: null });
    planReads();
    const connection = await connect(factory);
    const reply = await call(connection);
    expect(at(reply, 'result', 'content', 0, 'text')).toBe(
      confirmationSentence,
    );
  });
});

describe('a question before a write in the 2025 era', () => {
  const hello = async (
    connection: Awaited<ReturnType<typeof connect>>,
    capabilities: Json,
  ): Promise<void> => {
    await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities,
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    await connection.notify('notifications/initialized');
  };
  const call = (connection: Awaited<ReturnType<typeof connect>>) =>
    connection.request('tools/call', {
      name: 'ct_example_note_write',
      arguments: note,
    });

  it('asks through the shim of the SDK and writes after a yes', async () => {
    const { factory, planReads, commitReads, sent } = setup();
    planReads();
    commitReads();
    const connection = await connect(factory, () => ({
      action: 'accept',
      content: { bestaetigen: true },
    }));
    await hello(connection, { elicitation: {} });
    const reply = await call(connection);
    expect(connection.asked).toHaveLength(1);
    expect(at(connection.asked[0], 'method')).toBe('elicitation/create');
    expect(at(connection.asked[0], 'params', 'message')).toContain(
      'Ecclium möchte in ChurchTools schreiben.',
    );
    expect(at(reply, 'result', 'structuredContent')).toMatchObject({
      state: 'verified',
    });
    expect(sent()).toBe(1);
  });

  it('writes nothing after a decline through the shim', async () => {
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory, () => ({ action: 'decline' }));
    await hello(connection, { elicitation: {} });
    const reply = await call(connection);
    expect(at(reply, 'result', 'content', 0, 'text')).toBe(
      confirmationSentences.notConfirmed,
    );
    expect(sent()).toBe(0);
  });

  it('asks a client without elicitation nothing, so that the shim gives no error of its own', async () => {
    const { factory, planReads, sent } = setup();
    planReads();
    const connection = await connect(factory);
    await hello(connection, {});
    const reply = await call(connection);
    expect(connection.asked).toEqual([]);
    expect(at(reply, 'result', 'content', 0, 'text')).toBe(
      confirmationSentence,
    );
    expect(sent()).toBe(0);
  });
});
