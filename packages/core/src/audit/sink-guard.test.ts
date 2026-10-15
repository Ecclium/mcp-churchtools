import { describe, expect, it, vi } from 'vitest';

import { type AuditDraft, createAuditSink } from './index.js';

// The sink checks each field with its own schema, then the whole line with
// the schema of the event. The second check can only fail when the first
// has a bug, so this file plants one: the schema of the tenant takes any
// string. The sink must then write placeholders, never the bad value.
vi.mock(import('./schema.js'), async (importOriginal) => {
  const original = await importOriginal();
  const { z } = await import('zod');
  return {
    ...original,
    auditFieldSchemas: Object.freeze({
      ...original.auditFieldSchemas,
      tenantId: z.string(),
    }),
  };
});

describe('the sink with a bug in a field check', () => {
  it('writes placeholders and reports the mismatch, never the bad value', () => {
    const lines: string[] = [];
    const sink = createAuditSink({
      writer: {
        write: (line) => {
          lines.push(line);
          return true;
        },
      },
      clock: { now: () => Date.parse('2026-10-13T08:00:00.000Z') },
      isKnownTool: () => true,
      newId: () => 'a1b2c3d4-0000-4000-8000-000000000001',
    });
    const draft: AuditDraft = {
      type: 'tool_call',
      tenantId: 'Max Mustermann',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
      mode: 'interactive',
      outcome: 'ok',
      objectRefs: [],
      durationMs: 12,
    };
    sink.record(draft);
    expect(lines).toEqual([
      '{"v":1,"eventId":"a1b2c3d4-0000-4000-8000-000000000001","ts":"2026-10-13T08:00:00.000Z","type":"tool_call","tenantId":"invalid","actor":{"kind":"service","id":"invalid"},"mode":"unattended","outcome":"error","objectRefs":[],"errorCode":"internal","durationMs":0}',
      '{"ts":"2026-10-13T08:00:00.000Z","level":"error","event":"audit_schema_mismatch","eventId":"a1b2c3d4-0000-4000-8000-000000000001","code":"internal"}',
    ]);
  });
});
