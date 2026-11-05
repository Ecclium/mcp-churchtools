import {
  EccliumError,
  maxWikiTitleLength,
  type PlanOutcome,
  type PlannedWrite,
  type ReadApi,
  type TenantContext,
  type ToolDefinition,
  type WriteIntent,
  type WritePort,
  type WriteToolCall,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';

import {
  maxWriteTextLength,
  wikiPageCreateTool,
  wikiPageUpdateTool,
  wikiSectionAppendTool,
} from './write.js';

// The three tools only plan: each hands one intent to the write port and
// gives back what the port gave. The pipeline of the core, which seals,
// confirms and commits, runs them in the tests of the core and of the
// server; here they stand alone with a port that records the intents.

const guid = '00000000-0000-4000-8000-000000000001';
const planned: PlanOutcome = Object.freeze({
  kind: 'planned',
  plan: Object.freeze({}) as PlannedWrite,
});

const portOf = (
  answer: () => Promise<PlanOutcome>,
): { port: WritePort; intents: WriteIntent[] } => {
  const intents: WriteIntent[] = [];
  return {
    intents,
    port: {
      plan: (intent) => {
        intents.push(intent);
        return answer();
      },
    },
  };
};

const run = (
  tool: ToolDefinition,
  input: unknown,
  write: WritePort,
): Promise<unknown> => {
  const parsed = tool.input.parse(input);
  const call: WriteToolCall<unknown> = {
    ctx: {} as TenantContext,
    input: parsed,
    read: {} as ReadApi,
    write,
  };
  return tool.execute(call);
};

const cases = [
  {
    tool: wikiPageCreateTool,
    input: { categoryId: 4, title: 'Dienstplan', text: '# Dienstplan' },
    intent: {
      kind: 'wikiPageCreate',
      categoryId: 4,
      title: 'Dienstplan',
      text: '# Dienstplan',
    },
  },
  {
    tool: wikiPageUpdateTool,
    input: { categoryId: 4, guid, text: '# Neu', baseVersion: 3 },
    intent: {
      kind: 'wikiPageUpdate',
      categoryId: 4,
      guid,
      text: '# Neu',
      baseVersion: 3,
    },
  },
  {
    tool: wikiSectionAppendTool,
    input: { categoryId: 4, guid, section: '## Bericht', baseVersion: 3 },
    intent: {
      kind: 'wikiSectionAppend',
      categoryId: 4,
      guid,
      section: '## Bericht',
      baseVersion: 3,
    },
  },
] as const;

describe.each(cases)('$tool.name', ({ tool, input, intent }) => {
  it('hands exactly its intent to the write port and gives back its plan', async () => {
    const { port, intents } = portOf(() => Promise.resolve(planned));
    await expect(run(tool, input, port)).resolves.toBe(planned);
    expect(intents).toEqual([intent]);
  });

  it('gives back a skipped plan as the port gave it', async () => {
    const skipped: PlanOutcome = { kind: 'skipped', reason: 'already_written' };
    const { port } = portOf(() => Promise.resolve(skipped));
    await expect(run(tool, input, port)).resolves.toBe(skipped);
  });

  it.each([
    new EccliumError('conflict', 'changed'),
    new EccliumError('permission', 'right', {
      missingRights: [{ module: 'churchwiki', right: 'edit category' }],
    }),
    new EccliumError('policy_denied', 'off'),
    // A page or category the read of the plan did not find: the core gives
    // its fixed sentence, whatever a tool made of the error.
    new EccliumError('not_found'),
    new TypeError('not an error of the core'),
  ])('passes on every other refusal as the core made it: %s', async (error) => {
    const { port } = portOf(() => Promise.reject(error));
    await expect(run(tool, input, port)).rejects.toBe(error);
  });

  it('refuses an argument the model made up', () => {
    expect(tool.input.safeParse({ ...input, note: 'x' }).success).toBe(false);
  });

  it('is a write of the wiki that the core can take back', () => {
    expect(tool.meta).toMatchObject({
      capability: 'write',
      domain: 'wiki',
      tier: 'free',
      sensitivity: 'personal',
      unattended: 'policy',
      routineStable: false,
      reversible: 'snapshot',
    });
    expect(tool.meta.requiredRights).toEqual([
      { module: 'churchwiki', right: 'view' },
      { module: 'churchwiki', right: 'view category' },
      { module: 'churchwiki', right: 'edit category' },
    ]);
  });

  // Each description stands for itself (ADR 0065): it names no other tool
  // and says that a confirmation comes before every write.
  it('names no other tool and says that it writes only after a confirmation', () => {
    const text = Object.values(tool.description).join(' ');
    expect(text).not.toContain('ct_');
    expect(text).toContain('Writes only after a confirmation');
    expect(text).toContain('no links, web addresses, images, HTML');
  });
});

describe('the guards against a second write', () => {
  it('are the marking for a new page and a section, the version for a change', () => {
    expect(wikiPageCreateTool.meta.replayGuard).toBe('marker');
    expect(wikiSectionAppendTool.meta.replayGuard).toBe('marker');
    expect(wikiPageUpdateTool.meta.replayGuard).toBe('baseVersion');
  });

  it('are said in the descriptions: the server sets the marking, a repeat is skipped', () => {
    for (const tool of [wikiPageCreateTool, wikiSectionAppendTool]) {
      expect(tool.description.limits).toContain(
        'The server adds a line at the end that marks the text as written by Ecclium; a text must not bring such a line of its own.',
      );
    }
    expect(wikiSectionAppendTool.description.limits).toContain(
      'The same section on the same page on the same day is skipped.',
    );
    expect(wikiPageUpdateTool.description.limits).toContain(
      'Keep each line of the page that marks a text as written by Ecclium unchanged, and add none.',
    );
  });
});

describe('the input of the tools', () => {
  it.each([
    ['an empty title', { title: '' }],
    ['a title over the limit', { title: 'T'.repeat(maxWikiTitleLength + 1) }],
    ['an empty text', { text: '' }],
    ['a text over the limit', { text: 'x'.repeat(maxWriteTextLength + 1) }],
    ['a category 0', { categoryId: 0 }],
    ['a category as text', { categoryId: '4' }],
  ])('of a new page refuses %s', (_, change) => {
    const input = {
      categoryId: 4,
      title: 'Dienstplan',
      text: '# D',
      ...change,
    };
    expect(wikiPageCreateTool.input.safeParse(input).success).toBe(false);
  });

  it('of a new page takes the longest title and text', () => {
    const input = {
      categoryId: 4,
      title: 'T'.repeat(maxWikiTitleLength),
      text: 'x'.repeat(maxWriteTextLength),
    };
    expect(wikiPageCreateTool.input.safeParse(input).success).toBe(true);
  });

  it.each([
    ['a title instead of a GUID', { guid: 'Dienstplan' }],
    ['version 0', { baseVersion: 0 }],
    ['a version with a fraction', { baseVersion: 2.5 }],
    ['no version', { baseVersion: undefined }],
  ])('of a change and of a section refuses %s', (_, change) => {
    const update = { categoryId: 4, guid, text: '# T', baseVersion: 3 };
    const append = { categoryId: 4, guid, section: '## A', baseVersion: 3 };
    expect(
      wikiPageUpdateTool.input.safeParse({ ...update, ...change }).success,
    ).toBe(false);
    expect(
      wikiSectionAppendTool.input.safeParse({ ...append, ...change }).success,
    ).toBe(false);
  });
});
