import type { PlannedWrite } from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import { confirmationTextOf } from './confirmation-text.js';
import { contentHashOf } from './plan-hash.js';
import { queueEntryOf } from './queue-entry.js';
import { readPlan, sealPlan } from './sealed-plan.js';

const guid = '00000000-0000-4000-8000-000000000001';
const at = Date.UTC(2026, 10, 3, 17, 0, 0);

const intent = {
  kind: 'wikiSectionAppend',
  categoryId: 12,
  guid,
  section: '## Nachtrag',
  baseVersion: 3,
} as const;

const plan = sealPlan({
  tenantId: 'demo-tenant',
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  tool: 'ct_example_note_write',
  origin: 'plugin',
  intent,
  // The tool says less than the intent: the entry keeps what the core
  // derived.
  toolMeta: { sensitivity: 'none', unattended: 'policy', reversible: 'yes' },
  contentHash: contentHashOf(['# Plan\n\n## Nachtrag\n']),
  sealedAt: at,
  snapshots: false,
});

const text = confirmationTextOf({
  kind: 'wikiSectionAppend',
  categoryId: 12,
  title: 'Plan',
  before: '# Plan\n',
  after: '# Plan\n\n## Nachtrag\n',
});

describe('queueEntryOf', () => {
  it('makes the entry from the plan as the core derived it, with the text and the reason', () => {
    const view = readPlan(plan);
    const entry = queueEntryOf(plan, text, 'no_entry', at);
    expect(entry).toEqual({
      tool: 'ct_example_note_write',
      origin: 'plugin',
      toolMeta: {
        sensitivity: view?.rules.sensitivity,
        unattended: 'policy',
        reversible: 'no',
      },
      actor: { kind: 'service', id: 'stdio:local-stdio' },
      intent,
      planHash: view?.planHash,
      target: { kind: 'wiki_page', key: `12/${guid}` },
      summary: text.summary,
      diff: text.diff,
      reason: 'no_entry',
      queuedAt: at,
    });
    expect(entry.toolMeta.sensitivity).toBe('personal');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.toolMeta)).toBe(true);
    expect(Object.isFrozen(entry.target)).toBe(true);
  });

  it('keeps the whole title of a new page', () => {
    const create = sealPlan({
      tenantId: 'demo-tenant',
      actor: { kind: 'service', id: 'stdio:local-stdio' },
      tool: 'ct_example_note_write',
      origin: 'core',
      intent: { kind: 'wikiPageCreate', categoryId: 12, title: 'T', text: 'x' },
      toolMeta: { sensitivity: 'personal', unattended: 'policy' },
      contentHash: contentHashOf(['T', 'x']),
      sealedAt: at,
      snapshots: true,
    });
    const created = confirmationTextOf({
      kind: 'wikiPageCreate',
      categoryId: 12,
      title: 'T',
      before: '',
      after: 'x',
    });
    expect(queueEntryOf(create, created, 'too_long', at)).toMatchObject({
      title: 'T',
      target: { kind: 'wiki_category', key: '12' },
      reason: 'too_long',
    });
  });

  it('refuses a value that is no sealed plan', () => {
    expect(() =>
      queueEntryOf(
        { __ecclium: 'PlannedWrite' } as unknown as PlannedWrite,
        text,
        'setting',
        at,
      ),
    ).toThrow(TypeError);
  });
});
