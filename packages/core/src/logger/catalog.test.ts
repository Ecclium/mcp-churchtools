import { describe, expect, it } from 'vitest';

import { isLogEvent, logEvents, logLevels } from './catalog.js';
import { isEventName } from './fields.js';
import { createLogger, replacedEventName } from './logger.js';

// What the catalog promises about itself. That every line of the code has
// its entry is checked in tests/architecture/log-catalog.test.mts.
describe('the catalog of the log lines', () => {
  const names = Object.keys(logEvents);

  it('is frozen, entry by entry', () => {
    expect(Object.isFrozen(logEvents)).toBe(true);
    for (const name of names) {
      const entry = logEvents[name as keyof typeof logEvents];
      expect(Object.isFrozen(entry), name).toBe(true);
      expect(Object.isFrozen(entry.fields), name).toBe(true);
    }
  });

  it('holds only names of the pattern, and not the name that replaces others', () => {
    for (const name of names) expect(isEventName(name), name).toBe(true);
    expect(names).not.toContain(replacedEventName);
  });

  it('gives each event a level and fields without repeats', () => {
    for (const name of names) {
      const { level, fields } = logEvents[name as keyof typeof logEvents];
      expect(logLevels, name).toContain(level);
      expect(new Set(fields).size, name).toBe(fields.length);
    }
  });

  it('names only fields that a call may set and the logger keeps', () => {
    const lines: string[] = [];
    const log = createLogger({
      writer: {
        write: (line) => {
          lines.push(line);
          return true;
        },
      },
      clock: { now: () => 1_760_000_000_123 },
      minLevel: 'debug',
      prompts: new Set(['dienstplan_wochenende']),
      anchors: true,
    });
    const values: Record<string, string | number> = {
      prompt: 'dienstplan_wochenende',
      code: 'internal',
      durationMs: 1,
      count: 1,
      method: 'GET',
      status: 404,
      attempt: 1,
      file: 'audit-2026-10-23-055230-4242-1.jsonl',
      seq: 1,
      hash: 'a'.repeat(64),
    };
    for (const name of names) {
      const { level, fields } = logEvents[name as keyof typeof logEvents];
      log[level](
        name,
        Object.fromEntries(fields.map((field) => [field, values[field] ?? 0])),
      );
      const line = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
      expect(line['event'], name).toBe(name);
      expect(line, name).not.toHaveProperty('dropped');
      for (const field of fields) expect(line, name).toHaveProperty(field);
    }
  });

  it('tells its own names from any other value', () => {
    expect(isLogEvent('tool_call')).toBe(true);
    for (const value of [
      'tool_calls',
      'constructor',
      'toString',
      '__proto__',
      '',
      42,
      undefined,
      null,
      ['tool_call'],
      { toString: () => 'tool_call' },
    ]) {
      expect(isLogEvent(value), String(value)).toBe(false);
    }
  });
});
