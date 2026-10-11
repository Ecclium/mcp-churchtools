import { describe, expect, it } from 'vitest';

import { createSpikeLog } from './log.js';

// The record of the spike leaves the machine of the person who runs it
// (ADR 0053). These tests show that only listed fields of fitting kinds
// reach it, one line per event, and that values a client or the
// environment might slip in never appear.

const canary = 'CANARY-7f3a';
const fixedTime = Date.UTC(2026, 9, 11, 12, 0, 0);

function record(): { lines: string[]; log: ReturnType<typeof createSpikeLog> } {
  const lines: string[] = [];
  return {
    lines,
    log: createSpikeLog(
      (line) => lines.push(line),
      () => fixedTime,
    ),
  };
}

describe('createSpikeLog', () => {
  it('writes one JSON line per event, with time and name', () => {
    const { lines, log } = record();
    log.event('instance_created', { era: 'modern' });
    log.event('capability_absent', { era: 'legacy' });
    expect(lines).toEqual([
      '{"ts":"2026-10-11T12:00:00.000Z","event":"instance_created","era":"modern"}\n',
      '{"ts":"2026-10-11T12:00:00.000Z","event":"capability_absent","era":"legacy"}\n',
    ]);
  });

  it('drops fields that the event does not list', () => {
    const { lines, log } = record();
    log.event('retry_received', {
      nonce: 'a1b2c3d4',
      action: 'accept',
      ...({ content: { bestaetigt: canary }, requestState: canary } as object),
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: '2026-10-11T12:00:00.000Z',
      event: 'retry_received',
      nonce: 'a1b2c3d4',
      action: 'accept',
    });
  });

  it('writes null for a value that does not fit its kind', () => {
    const { lines, log } = record();
    log.event('tool_call', {
      call: { nested: canary },
      era: 'ancient',
      clientName: `${canary}\n{"event":"forged"}`,
      clientVersion: 'x'.repeat(65),
      capabilities: 'elicitation',
      requestState: 'yes',
    });
    log.event('retry_received', { round: -1, elapsedMs: 1.5, action: canary });
    log.event('request_rejected', { reason: 'Invalid requestState for user' });
    log.event('response_sent', { errorCode: '-32602', outcome: 'maybe' });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        ts: '2026-10-11T12:00:00.000Z',
        event: 'tool_call',
        call: null,
        era: null,
        clientName: null,
        clientVersion: null,
        capabilities: null,
        requestState: null,
      },
      {
        ts: '2026-10-11T12:00:00.000Z',
        event: 'retry_received',
        round: null,
        elapsedMs: null,
        action: null,
      },
      {
        ts: '2026-10-11T12:00:00.000Z',
        event: 'request_rejected',
        reason: null,
      },
      {
        ts: '2026-10-11T12:00:00.000Z',
        event: 'response_sent',
        errorCode: null,
        outcome: null,
      },
    ]);
  });

  it('keeps only names in a list of names, sorted and at most 32', () => {
    const { lines, log } = record();
    const many = Array.from(
      { length: 40 },
      (_, index) => `key${String(index)}`,
    );
    log.event('tool_call', {
      capabilities: [
        'roots',
        'elicitation.form',
        canary.toLowerCase() + ' ',
        'elicitation',
        7,
      ],
      metaKeys: many,
    });
    const line = JSON.parse(lines[0] ?? '') as {
      capabilities: unknown;
      metaKeys: unknown[];
    };
    expect(line.capabilities).toEqual([
      'elicitation',
      'elicitation.form',
      'roots',
    ]);
    expect(line.metaKeys).toHaveLength(32);
  });

  it('accepts the names a client typically sends', () => {
    const { lines, log } = record();
    log.event('client_hello', {
      protocolVersion: '2025-11-25',
      clientName: 'example-client (desktop)',
      clientVersion: '2.1.296',
      capabilities: ['io.modelcontextprotocol/ui', 'extensions.example/ui'],
    });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      protocolVersion: '2025-11-25',
      clientName: 'example-client (desktop)',
      clientVersion: '2.1.296',
      capabilities: ['extensions.example/ui', 'io.modelcontextprotocol/ui'],
    });
  });

  it('never writes the canary, whatever the fields', () => {
    const { lines, log } = record();
    const fields = {
      call: canary,
      nonce: `${canary}!`,
      clientName: ` ${canary}`,
      contentKeys: [`${canary}=1`],
      kind: canary,
      reason: canary,
    };
    log.event('tool_call', fields);
    log.event('retry_received', fields);
    log.event('server_error', fields);
    log.event('request_rejected', fields);
    expect(lines.join('')).not.toContain(canary);
    expect(lines).toHaveLength(4);
  });
});
