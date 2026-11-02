import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  classify,
  defineWriteTool,
  type PlanOutcome,
  type WriteIntentKind,
  writeIntentKinds,
  writeResultSchema,
  writeTargetKinds,
} from './index.js';

// Every kind of the union, once, so that the list at run time cannot miss
// one the types know.
const everyKind = {
  wikiPageCreate: true,
  wikiPageUpdate: true,
  wikiSectionAppend: true,
  appointmentCreate: true,
  appointmentUpdate: true,
  bookingCreate: true,
  groupMemberAdd: true,
  groupMemberRemove: true,
  serviceRequest: true,
  apiOperation: true,
} satisfies Record<WriteIntentKind, true>;

describe('the contract of a write', () => {
  it('lists every kind of intent once, frozen', () => {
    expect([...writeIntentKinds].sort()).toEqual(Object.keys(everyKind).sort());
    expect(new Set(writeIntentKinds).size).toBe(writeIntentKinds.length);
    expect(Object.isFrozen(writeIntentKinds)).toBe(true);
  });

  it('lists the six writes of the core before the four of the Pro module', () => {
    expect(writeIntentKinds.slice(6)).toEqual([
      'groupMemberAdd',
      'groupMemberRemove',
      'serviceRequest',
      'apiOperation',
    ]);
  });
});

describe('the result of a write tool', () => {
  it('takes a verified or skipped write with its target and version', () => {
    for (const value of [
      {
        state: 'verified',
        target: { kind: 'wiki_page', key: '12/x' },
        version: 4,
      },
      { state: 'skipped', target: { kind: 'wiki_category', key: '12' } },
    ]) {
      expect(writeResultSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses another state, an unknown target and a version below 0', () => {
    for (const value of [
      { state: 'planned', target: { kind: 'wiki_page', key: '12/x' } },
      { state: 'verified', target: { kind: 'person', key: '1' } },
      { state: 'verified', target: { kind: 'wiki_page', key: '' } },
      {
        state: 'verified',
        target: { kind: 'wiki_page', key: '1' },
        version: -1,
      },
    ]) {
      expect(writeResultSchema.safeParse(value).success).toBe(false);
    }
  });

  it('lists every kind of target once, frozen', () => {
    expect(new Set(writeTargetKinds).size).toBe(8);
    expect(Object.isFrozen(writeTargetKinds)).toBe(true);
  });
});

describe('a write tool', () => {
  it('gets the result of a write as its output and keeps its execute', async () => {
    const planned: PlanOutcome = { kind: 'skipped', reason: 'unchanged' };
    const tool = defineWriteTool({
      name: 'ct_example_note_append',
      meta: {
        capability: 'write',
        domain: 'wiki',
        requiredRights: [],
        tier: 'free',
        sensitivity: 'personal',
        unattended: 'policy',
        routineStable: false,
        reversible: 'snapshot',
        replayGuard: 'marker',
      },
      description: { purpose: 'p', useWhen: 'u', avoidWhen: 'a', limits: 'l' },
      input: z.object({ section: classify(z.string(), 'untrusted') }),
      execute: ({ write }) =>
        write.plan({
          kind: 'wikiSectionAppend',
          categoryId: 12,
          guid: '00000000-0000-4000-8000-000000000001',
          section: '## x',
          baseVersion: 1,
        }),
    });
    expect(tool.output).toBe(writeResultSchema);
    expect(tool.name).toBe('ct_example_note_append');
    const call = {
      write: { plan: () => Promise.resolve(planned) },
    } as unknown as Parameters<typeof tool.execute>[0];
    expect(await tool.execute(call)).toBe(planned);
  });
});
