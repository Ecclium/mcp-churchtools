import { PassThrough } from 'node:stream';

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpikeLog } from './log.js';
import {
  createSpikeCodec,
  createSpikeServer,
  spikeQuestionKey,
  spikeToolName,
} from './server.js';
import { startSpike } from './stdio.js';

// Drives the spike in process, without a client package and without a
// socket: one end of an in-memory pair goes to the same composition as the
// stdio start, the test plays the client with raw JSON-RPC (ADR 0053).
// The network guard of the test process stays active throughout.

type Json = Readonly<Record<string, unknown>>;

/** Reads a value along a path of keys, undefined where the path ends. */
const at = (value: unknown, ...path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Readonly<Record<string | number, unknown>>)[key]
        : undefined,
    value,
  );

const canary = 'CANARY-4b9e';
const key = new Uint8Array(32).fill(7);

/** Answers the client gives to a question of the shim of the SDK. */
type Answer = (params: unknown) => Json;

interface Connection {
  /** Sends a request and resolves with the response that has its id. */
  readonly request: (method: string, params: Json) => Promise<Json>;
  /** Sends a notification. */
  readonly notify: (method: string) => Promise<void>;
  /** The record so far, one object per line. */
  readonly events: () => readonly Json[];
  /** The record so far, as written. */
  readonly text: () => string;
  /** Ends the connection. */
  readonly close: () => Promise<void>;
}

const open: StdioServerHandle[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
  vi.useRealTimers();
});

async function connect(answer?: Answer): Promise<Connection> {
  const lines: string[] = [];
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Json) => void>();
  let lastId = 0;
  let nonces = 0;
  client.onmessage = (message) => {
    const id = at(message, 'id');
    if (typeof at(message, 'method') === 'string' && id !== undefined) {
      // A request from the server: in these tests only the shim sends one.
      const reply = {
        jsonrpc: '2.0',
        id,
        result: answer?.(at(message, 'params')) ?? { action: 'cancel' },
      } as unknown as JSONRPCMessage;
      void client.send(reply);
    } else if (typeof id === 'number') {
      pending.get(id)?.(message);
      pending.delete(id);
    }
  };
  await client.start();
  const handle = startSpike({
    transport: wire,
    write: (line) => lines.push(line),
    now: () => Date.now(),
    key,
    newNonce: () => {
      nonces += 1;
      return `${nonces.toString(16).padStart(6, '0')}9f8e7d6c`;
    },
    instanceId: 'test-instance',
  });
  open.push(handle);
  return {
    request: async (method, params) => {
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
    },
    notify: (method) =>
      client.send({ jsonrpc: '2.0', method } as unknown as JSONRPCMessage),
    events: () => lines.map((line) => JSON.parse(line) as Json),
    text: () => lines.join(''),
    close: () => handle.close(),
  };
}

const modernMeta = (capabilities: unknown): Json => ({
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: capabilities,
});

const named = (events: readonly Json[], name: string): Json[] =>
  events.filter((event) => event['event'] === name);

const answerWith = (action: string, content?: Json): Json => ({
  [spikeQuestionKey]: content === undefined ? { action } : { action, content },
});

describe('the 2026 era', () => {
  const ask = (connection: Connection, extra: Json = {}): Promise<Json> =>
    connection.request('tools/call', {
      name: spikeToolName,
      _meta: modernMeta({ elicitation: {} }),
      ...extra,
    });

  it('asks once in form mode and records an accepted answer', async () => {
    const connection = await connect();
    const first = await ask(connection);
    expect(at(first, 'result', 'resultType')).toBe('input_required');
    const question = at(first, 'result', 'inputRequests', spikeQuestionKey);
    expect(at(question, 'method')).toBe('elicitation/create');
    expect(at(question, 'params', 'mode')).toBe('form');
    expect(at(question, 'params', 'message')).toContain('Ecclium-Spike 000001');
    expect(
      Object.keys(
        at(question, 'params', 'requestedSchema', 'properties') as Json,
      ),
    ).toEqual(['bestaetigt', 'farbe']);

    const second = await ask(connection, {
      inputResponses: answerWith('accept', { bestaetigt: true, farbe: 'blau' }),
      requestState: at(first, 'result', 'requestState'),
    });
    expect(at(second, 'result', 'resultType')).toBe('complete');
    expect(at(second, 'result', 'content', 0, 'text')).toContain('"accept"');

    const events = connection.events();
    // The transport sees the first message before serveStdio builds the
    // instance for it.
    expect(events.map((event) => event['event'])).toEqual([
      'process_start',
      'tool_call',
      'instance_created',
      'input_required_issued',
      'response_sent',
      'tool_call',
      'retry_received',
      'response_sent',
    ]);
    expect(named(events, 'tool_call')).toMatchObject([
      {
        call: 1,
        era: 'modern',
        protocolVersion: '2026-07-28',
        clientName: 'test-client',
        clientVersion: '1.0.0',
        capabilities: ['elicitation'],
        requestState: false,
        inputResponses: [],
      },
      { call: 2, requestState: true, inputResponses: [spikeQuestionKey] },
    ]);
    expect(named(events, 'input_required_issued')).toMatchObject([
      { nonce: '0000019f8e7d6c', code: '000001', round: 1 },
    ]);
    expect(named(events, 'retry_received')).toMatchObject([
      {
        nonce: '0000019f8e7d6c',
        round: 1,
        action: 'accept',
        contentKeys: ['bestaetigt', 'farbe'],
        valid: true,
      },
    ]);
    expect(named(events, 'response_sent')).toMatchObject([
      { call: 1, outcome: 'input_required' },
      { call: 2, outcome: 'result' },
    ]);
  });

  it.each(['decline', 'cancel'])(
    'records %s and does not ask again',
    async (action) => {
      const connection = await connect();
      const first = await ask(connection);
      const second = await ask(connection, {
        inputResponses: answerWith(action),
        requestState: at(first, 'result', 'requestState'),
      });
      expect(at(second, 'result', 'resultType')).toBe('complete');
      const events = connection.events();
      expect(named(events, 'input_required_issued')).toHaveLength(1);
      expect(named(events, 'retry_received')).toMatchObject([
        { action, contentKeys: [] },
      ]);
      expect(named(events, 'retry_received')[0]).not.toHaveProperty('valid');
    },
  );

  it('marks accepted content that does not fit the form, without its values', async () => {
    const connection = await connect();
    const first = await ask(connection);
    await ask(connection, {
      inputResponses: answerWith('accept', {
        bestaetigt: canary,
        farbe: canary,
      }),
      requestState: at(first, 'result', 'requestState'),
    });
    expect(named(connection.events(), 'retry_received')).toMatchObject([
      { action: 'accept', contentKeys: ['bestaetigt', 'farbe'], valid: false },
    ]);
    expect(connection.text()).not.toContain(canary);
  });

  it.each([{}, { elicitation: { url: {} } }, { sampling: {} }])(
    'does not ask a client that declares %j',
    async (capabilities) => {
      const connection = await connect();
      const reply = await connection.request('tools/call', {
        name: spikeToolName,
        _meta: modernMeta(capabilities),
      });
      expect(at(reply, 'result', 'resultType')).toBe('complete');
      const events = connection.events();
      expect(named(events, 'capability_absent')).toEqual([
        expect.objectContaining({ era: 'modern' }),
      ]);
      expect(named(events, 'input_required_issued')).toEqual([]);
    },
  );

  it('rejects a forged requestState and records only the reason', async () => {
    const connection = await connect();
    const first = await ask(connection);
    const state = String(at(first, 'result', 'requestState'));
    const forged = `${state.slice(0, -4)}AAAA`;
    const reply = await ask(connection, {
      inputResponses: answerWith('accept', { bestaetigt: true }),
      requestState: forged,
    });
    expect(at(reply, 'error', 'code')).toBe(-32602);
    expect(at(reply, 'error', 'data', 'reason')).toBe('invalid_request_state');
    const events = connection.events();
    expect(named(events, 'request_rejected')).toMatchObject([
      { reason: 'mac' },
    ]);
    expect(named(events, 'retry_received')).toEqual([]);
    expect(named(events, 'response_sent').at(-1)).toMatchObject({
      outcome: 'error',
      errorCode: -32602,
    });
    expect(connection.text()).not.toContain(state);
    expect(connection.text()).not.toContain(forged);
  });

  it('treats a call without requestState as a new question', async () => {
    const connection = await connect();
    await ask(connection);
    await ask(connection, { inputResponses: answerWith('accept') });
    const issued = named(connection.events(), 'input_required_issued');
    expect(issued.map((event) => event['nonce'])).toEqual([
      '0000019f8e7d6c',
      '0000029f8e7d6c',
    ]);
  });
});

describe('the codec for the requestState', () => {
  const context = (method: string): ServerContext =>
    ({ mcpReq: { method } }) as unknown as ServerContext;
  const state = { nonce: 'a1b2c3d4', mintedAt: 0, round: 1 };

  it('refuses a state minted for another method', async () => {
    const codec = createSpikeCodec(key);
    const minted = await codec.mint(state, context('tools/call'));
    await expect(codec.verify(minted, context('tools/call'))).resolves.toEqual(
      state,
    );
    await expect(codec.verify(minted, context('prompts/get'))).rejects.toThrow(
      'bind',
    );
  });

  it('refuses a state from a process with another key', async () => {
    const minted = await createSpikeCodec(key).mint(
      state,
      context('tools/call'),
    );
    const other = createSpikeCodec(new Uint8Array(32).fill(8));
    await expect(other.verify(minted, context('tools/call'))).rejects.toThrow(
      'mac',
    );
  });

  it('refuses a state after 600 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 0, 0));
    const codec = createSpikeCodec(key);
    const minted = await codec.mint(state, context('tools/call'));
    vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 9, 59));
    await expect(codec.verify(minted, context('tools/call'))).resolves.toEqual(
      state,
    );
    vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 10, 1));
    await expect(codec.verify(minted, context('tools/call'))).rejects.toThrow(
      'expired',
    );
  });
});

describe('clients of the 2025 era', () => {
  const hello = async (
    connection: Connection,
    capabilities: Json,
  ): Promise<void> => {
    await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities,
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    await connection.notify('notifications/initialized');
  };
  const call = (connection: Connection): Promise<Json> =>
    connection.request('tools/call', { name: spikeToolName, arguments: {} });

  it.each([
    ['accept', { bestaetigt: false }],
    ['decline', undefined],
    ['cancel', undefined],
  ] as const)(
    'passes %s through the shim and keeps the requestState',
    async (action, content) => {
      const connection = await connect(() =>
        content === undefined ? { action } : { action, content },
      );
      await hello(connection, { elicitation: {} });
      const reply = await call(connection);
      expect(at(reply, 'result', 'isError')).toBeUndefined();
      expect(at(reply, 'result', 'content', 0, 'text')).toContain(
        `"${action}"`,
      );
      const events = connection.events();
      expect(named(events, 'instance_created')).toMatchObject([
        { era: 'legacy' },
      ]);
      expect(named(events, 'client_hello')).toMatchObject([
        {
          protocolVersion: '2025-11-25',
          clientName: 'older-client',
          clientVersion: '0.9.0',
          capabilities: ['elicitation'],
        },
      ]);
      expect(named(events, 'tool_call')).toMatchObject([
        {
          era: 'legacy',
          protocolVersion: '2025-11-25',
          clientName: 'older-client',
          capabilities: ['elicitation'],
        },
      ]);
      expect(named(events, 'elicitation_sent')).toMatchObject([
        { elicitation: 1 },
      ]);
      expect(named(events, 'elicitation_answered')).toMatchObject([
        { elicitation: 1, action },
      ]);
      // The nonce of the question comes back in the retry: the shim hands
      // the checked requestState to the handler.
      expect(named(events, 'retry_received')).toMatchObject([
        { nonce: '0000019f8e7d6c', action },
      ]);
      expect(named(events, 'response_sent')).toMatchObject([
        { outcome: 'result' },
      ]);
    },
  );

  it('marks content the shim lets through unchecked as not valid', async () => {
    const connection = await connect(() => ({
      action: 'accept',
      content: { bestaetigt: canary },
    }));
    await hello(connection, { elicitation: {} });
    await call(connection);
    expect(named(connection.events(), 'retry_received')).toMatchObject([
      { action: 'accept', valid: false },
    ]);
    expect(connection.text()).not.toContain(canary);
  });

  it('answers with isError when the client declared no elicitation', async () => {
    const connection = await connect();
    await hello(connection, {});
    const reply = await call(connection);
    expect(at(reply, 'result', 'isError')).toBe(true);
    const events = connection.events();
    expect(named(events, 'elicitation_sent')).toEqual([]);
    expect(named(events, 'retry_received')).toEqual([]);
    expect(named(events, 'response_sent')).toMatchObject([
      { outcome: 'is_error' },
    ]);
  });
});

describe('instances', () => {
  it('builds a second instance when a client falls back from server/discover to initialize', async () => {
    const connection = await connect();
    const discovered = await connection.request('server/discover', {
      _meta: modernMeta({ elicitation: {} }),
    });
    expect(at(discovered, 'result', 'supportedVersions')).toEqual([
      '2026-07-28',
    ]);
    await connection.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'older-client', version: '0.9.0' },
    });
    expect(named(connection.events(), 'instance_created')).toMatchObject([
      { era: 'modern' },
      { era: 'legacy' },
    ]);
  });
});

describe('the stdio framing', () => {
  it('writes only JSON-RPC to stdout and the record elsewhere', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const lines: string[] = [];
    const handle = startSpike({
      transport: new StdioServerTransport(input, output),
      write: (line) => lines.push(line),
      now: () => Date.now(),
      key,
      newNonce: () => 'abcdef0123456789',
      instanceId: 'test-instance',
    });
    open.push(handle);
    const send = (message: Json): void => {
      input.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: spikeToolName, _meta: modernMeta({ elicitation: {} }) },
    });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: spikeToolName, _meta: modernMeta({}) },
    });
    await vi.waitFor(() => {
      expect(written.trim().split('\n')).toHaveLength(2);
    });
    for (const line of written.trim().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(written).not.toContain(line.trim());
    }
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      event: 'process_start',
      instanceId: 'test-instance',
      sdkVersion: '2.3.1',
    });
  });
});

describe('errors of the instance', () => {
  it('records a fixed word, never the message', () => {
    const lines: string[] = [];
    const log = createSpikeLog(
      (line) => lines.push(line),
      () => Date.now(),
    );
    const mcp = createSpikeServer({
      codec: createSpikeCodec(key),
      log,
      now: () => Date.now(),
      newNonce: () => 'abcdef0123456789',
    })({ era: 'modern' });
    if (!(mcp instanceof McpServer)) throw new Error('expected an McpServer');
    mcp.server.onerror?.(
      new Error(`ENOENT: /srv/ecclium/${canary}.json {"farbe":"${canary}"}`),
    );
    mcp.server.onerror?.(
      new Error('requestState verification rejected tools/call: expired'),
    );
    mcp.server.onerror?.(
      new Error(`requestState verification rejected tools/call: ${canary}`),
    );
    expect(lines.map((line) => JSON.parse(line) as Json)).toMatchObject([
      { event: 'instance_created', era: 'modern' },
      { event: 'server_error', kind: 'other' },
      { event: 'request_rejected', reason: 'expired' },
      { event: 'server_error', kind: 'other' },
    ]);
    expect(lines.join('')).not.toContain(canary);
    expect(lines.join('')).not.toContain('/srv/ecclium');
  });
});
