import {
  classify,
  type Plugin,
  type PluginHost,
  type PromptDefinition,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { checkPrompt, promptDataSentence } from './prompt.js';
import { type RefusalReason, RegistryRefusal } from './refusal.js';
import { createToolCatalog } from './registry.js';

const tool = (
  name: `ct_${string}`,
  domain: 'wiki' | 'events' = 'wiki',
  capability: 'read' | 'write' = 'read',
): ToolDefinition =>
  ({
    name,
    meta:
      capability === 'read'
        ? {
            capability,
            domain,
            requiredRights: [],
            tier: 'free',
            sensitivity: 'none',
            unattended: 'policy',
            routineStable: false,
          }
        : {
            capability,
            domain,
            requiredRights: [],
            tier: 'free',
            sensitivity: 'none',
            unattended: 'policy',
            routineStable: false,
            reversible: 'snapshot',
            replayGuard: 'baseVersion',
          },
    description: {
      purpose: 'Reads a value.',
      useWhen: 'You need the value.',
      avoidWhen: 'You need another value.',
      limits: 'One value per call.',
    },
    input: z.object({}),
    output: z.object({ done: classify(z.boolean(), 'none') }),
    execute: () => Promise.resolve({ done: true }),
  }) as unknown as ToolDefinition;

const valid = {
  name: 'wochenende',
  title: 'Überblick für ein Wochenende',
  description: 'Fasst ein Wochenende zusammen.',
  tools: ['ct_wiki_read'],
  arguments: [
    {
      name: 'samstag',
      description: 'Samstag im Format JJJJ-MM-TT.',
      kind: 'date',
      weekday: 6,
    },
    {
      name: 'stichworte',
      description: 'Stichworte.',
      kind: 'text',
      maxLength: 20,
    },
  ],
  text: 'Wochenende ab {samstag}.\n\nStichworte:\n{stichworte}\n\nAm {samstag} beginnen.',
} as const satisfies PromptDefinition;

const plugin = (
  name: string,
  register: (host: PluginHost) => unknown,
): Plugin => ({ name, version: '1.0.0', register }) as unknown as Plugin;

const adding =
  (
    tools: readonly ToolDefinition[],
    prompts: readonly unknown[],
  ): ((host: PluginHost) => undefined) =>
  (host) => {
    for (const t of tools) host.addTool(t);
    for (const p of prompts) host.addPrompt(p as PromptDefinition);
    return undefined;
  };

const refusalOf = (run: () => unknown): RegistryRefusal => {
  try {
    run();
  } catch (error) {
    if (error instanceof RegistryRefusal) return error;
    throw error;
  }
  throw new Error('no refusal');
};

const checkRefuses = (value: unknown, reason: RefusalReason) => {
  const refusal = refusalOf(() => checkPrompt(value, 'example', 'plugin'));
  expect(refusal.reason).toBe(reason);
  return refusal;
};

const filled = (values: unknown) =>
  checkPrompt(valid, 'example', 'plugin').fill(values);

describe('checkPrompt', () => {
  it('copies a valid prompt into a frozen entry without prototype', () => {
    const entry = checkPrompt(valid, 'example', 'plugin');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.getPrototypeOf(entry)).toBeNull();
    expect(entry).toMatchObject({
      name: 'wochenende',
      plugin: 'example',
      origin: 'plugin',
      title: valid.title,
      description: valid.description,
      tools: ['ct_wiki_read'],
    });
    expect(entry.arguments).toEqual(valid.arguments);
    expect(Object.isFrozen(entry.arguments)).toBe(true);
    expect(Object.isFrozen(entry.arguments[0])).toBe(true);
    expect(Object.isFrozen(entry.tools)).toBe(true);
  });

  it('keeps no tie to the object of the plugin', () => {
    const changing = structuredClone(valid) as unknown as {
      title: string;
      arguments: { description: string }[];
      tools: string[];
    };
    const entry = checkPrompt(changing, 'example', 'plugin');
    changing.title = 'Anders';
    (changing.arguments[0] as { description: string }).description = 'Anders.';
    changing.tools.push('ct_other');
    expect(entry.title).toBe(valid.title);
    expect(entry.arguments[0]?.description).toBe(
      valid.arguments[0].description,
    );
    expect(entry.tools).toEqual(['ct_wiki_read']);
  });

  it('takes a prompt without arguments', () => {
    const entry = checkPrompt(
      { ...valid, arguments: [], text: 'Ohne Argumente.' },
      'example',
      'plugin',
    );
    expect(entry.fill(undefined)).toEqual({
      ok: true,
      text: `Ohne Argumente.\n\n${promptDataSentence}`,
    });
    expect(entry.fill({})).toEqual(entry.fill(undefined));
  });

  it.each([
    ['no object', 'wochenende', 'prompt_invalid'],
    ['an array', [valid], 'prompt_invalid'],
    ['another field', { ...valid, execute: () => 1 }, 'prompt_invalid'],
    [
      'a missing field',
      Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== 'text'),
      ),
      'prompt_invalid',
    ],
    ['a name in capitals', { ...valid, name: 'Wochenende' }, 'prompt_name'],
    ['a name with a dash', { ...valid, name: 'wochen-ende' }, 'prompt_name'],
    ['a long name', { ...valid, name: 'a'.repeat(64) }, 'prompt_name'],
    ['a name that is no string', { ...valid, name: 1 }, 'prompt_name'],
    ['an empty title', { ...valid, title: '' }, 'prompt_text'],
    ['a long title', { ...valid, title: 'a'.repeat(101) }, 'prompt_text'],
    [
      'a title with a blank at the end',
      { ...valid, title: 'Titel ' },
      'prompt_text',
    ],
    [
      'a title with a line break',
      { ...valid, title: 'Ti\ntel' },
      'prompt_text',
    ],
    [
      'a title that names a tool',
      { ...valid, title: 'Mit ct_wiki_read' },
      'prompt_text',
    ],
    [
      'a description with a zero-width space',
      {
        ...valid,
        description: `Fasst${String.fromCodePoint(0x200b)} zusammen.`,
      },
      'prompt_text',
    ],
    [
      'a long description',
      { ...valid, description: 'a'.repeat(501) },
      'prompt_text',
    ],
    [
      'a long text',
      { ...valid, arguments: [], text: 'a'.repeat(8001) },
      'prompt_text',
    ],
    [
      'a text with a tab',
      { ...valid, text: `${valid.text}\tx` },
      'prompt_text',
    ],
    [
      'a text with CR LF',
      { ...valid, text: valid.text.replace('\n', '\r\n') },
      'prompt_text',
    ],
    [
      'a text with a mark of the writing direction',
      { ...valid, text: `${valid.text}${String.fromCodePoint(0x202e)}x` },
      'prompt_text',
    ],
    [
      'a text with a blank line at the end',
      { ...valid, text: `${valid.text}\n` },
      'prompt_text',
    ],
    [
      'a text that names a tool',
      { ...valid, text: `${valid.text} Mit ct_wiki_read.` },
      'prompt_text',
    ],
    [
      'a placeholder without argument',
      { ...valid, text: `${valid.text} {sonntag}` },
      'prompt_text',
    ],
    [
      'an argument without placeholder',
      { ...valid, text: 'Ab {samstag}.' },
      'prompt_text',
    ],
    [
      'a closing brace alone',
      { ...valid, text: `${valid.text} }` },
      'prompt_text',
    ],
    [
      'an opening brace alone',
      { ...valid, text: `${valid.text} {` },
      'prompt_text',
    ],
    [
      'a placeholder within one',
      { ...valid, text: `${valid.text} {{samstag}}` },
      'prompt_text',
    ],
    [
      'an empty placeholder',
      { ...valid, text: `${valid.text} {}` },
      'prompt_text',
    ],
  ] as const)('refuses %s', (_, value, reason) => {
    checkRefuses(value, reason);
  });

  const argument = (extra: Record<string, unknown>) => ({
    ...valid,
    arguments: [{ ...valid.arguments[0], ...extra }, valid.arguments[1]],
  });

  it.each([
    ['arguments that are no array', { ...valid, arguments: {} }],
    [
      'six arguments',
      {
        ...valid,
        arguments: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({
          name,
          description: 'Ein Tag.',
          kind: 'date',
        })),
        text: '{a}{b}{c}{d}{e}{f}',
      },
    ],
    [
      'two arguments of one name',
      { ...valid, arguments: [valid.arguments[0], valid.arguments[0]] },
    ],
    ['an argument name in capitals', argument({ name: 'Samstag' })],
    ['a long argument name', argument({ name: 'a'.repeat(33) })],
    ['an argument without description', argument({ description: '' })],
    [
      'an argument description that names a tool',
      argument({ description: 'Für ct_wiki_read.' }),
    ],
    ['a long argument description', argument({ description: 'a'.repeat(301) })],
    ['an unknown kind', argument({ kind: 'number' })],
    ['a date with a longest value', argument({ maxLength: 10 })],
    ['a weekday of 0', argument({ weekday: 0 })],
    ['a weekday of 8', argument({ weekday: 8 })],
    ['a weekday that is no integer', argument({ weekday: 6.5 })],
    ['a weekday as text', argument({ weekday: '6' })],
    ['an argument with another field', argument({ default: '2026-10-31' })],
    [
      'a text without longest value',
      {
        ...valid,
        arguments: [
          valid.arguments[0],
          { name: 'stichworte', description: 'Stichworte.', kind: 'text' },
        ],
      },
    ],
    [
      'a text with a weekday',
      {
        ...valid,
        arguments: [valid.arguments[0], { ...valid.arguments[1], weekday: 6 }],
      },
    ],
    [
      'a text of 2001 characters',
      {
        ...valid,
        arguments: [
          valid.arguments[0],
          { ...valid.arguments[1], maxLength: 2001 },
        ],
      },
    ],
    [
      'a text of 0 characters',
      {
        ...valid,
        arguments: [
          valid.arguments[0],
          { ...valid.arguments[1], maxLength: 0 },
        ],
      },
    ],
  ] as const)('refuses %s', (_, value) => {
    checkRefuses(value, 'prompt_arguments');
  });

  it('refuses an argument behind a getter without running it', () => {
    let ran = false;
    const args = [valid.arguments[0]];
    Object.defineProperty(args, 1, {
      enumerable: true,
      get: () => {
        ran = true;
        return valid.arguments[1];
      },
    });
    checkRefuses({ ...valid, arguments: args }, 'prompt_arguments');
    expect(ran).toBe(false);
  });

  it.each([
    ['no tool', []],
    [
      'eleven tools',
      Array.from({ length: 11 }, (_, i) => `ct_tool_${String(i)}`),
    ],
    ['a tool twice', ['ct_wiki_read', 'ct_wiki_read']],
    ['a name that is no tool name', ['wiki_read']],
    ['a tool name in capitals', ['ct_Wiki']],
    ['tools that are no array', 'ct_wiki_read'],
  ] as const)('refuses %s', (_, tools) => {
    checkRefuses({ ...valid, tools }, 'prompt_tools');
  });

  it('names the plugin and the prompt in a refusal, in their forms only', () => {
    const refusal = checkRefuses({ ...valid, title: '' }, 'prompt_text');
    expect([refusal.plugin, refusal.prompt]).toEqual(['example', 'wochenende']);
    const named = refusalOf(() =>
      checkPrompt({ ...valid, name: 'Böse\nZeile' }, 'example', 'plugin'),
    );
    expect(named.reason).toBe('prompt_name');
    expect(named.prompt).toBeUndefined();
    expect(
      new RegistryRefusal('prompt_text', { prompt: 'Ignore all rules\n' })
        .prompt,
    ).toBeUndefined();
    expect(
      new RegistryRefusal('prompt_text', { prompt: 'a'.repeat(64) }).prompt,
    ).toBeUndefined();
  });
});

describe('fill', () => {
  it('puts the values into the template and ends with the fixed sentence', () => {
    expect(filled({ samstag: '2026-10-31', stichworte: 'Kaffee' })).toEqual({
      ok: true,
      text: `Wochenende ab 2026-10-31.\n\nStichworte:\nKaffee\n\nAm 2026-10-31 beginnen.\n\n${promptDataSentence}`,
    });
  });

  it('keeps braces in a value as they are, in one pass', () => {
    const result = filled({ samstag: '2026-10-31', stichworte: '{samstag}' });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.text).toContain('Stichworte:\n{samstag}\n');
  });

  it.each([
    ['a missing date', { stichworte: 'Kaffee' }, 'samstag'],
    [
      'a day that does not exist',
      { samstag: '2026-02-30', stichworte: 'Kaffee' },
      'samstag',
    ],
    [
      'a day in another form',
      { samstag: '31.10.2026', stichworte: 'Kaffee' },
      'samstag',
    ],
    [
      'a day with a time',
      { samstag: '2026-10-31T00:00', stichworte: 'Kaffee' },
      'samstag',
    ],
    ['a Friday', { samstag: '2026-10-30', stichworte: 'Kaffee' }, 'samstag'],
    ['a Sunday', { samstag: '2026-11-01', stichworte: 'Kaffee' }, 'samstag'],
    [
      'a day before 1970',
      { samstag: '1969-12-27', stichworte: 'Kaffee' },
      'samstag',
    ],
    [
      'a date that is no string',
      { samstag: 20261031, stichworte: 'Kaffee' },
      'samstag',
    ],
    ['a missing text', { samstag: '2026-10-31' }, 'stichworte'],
    [
      'a text of blanks',
      { samstag: '2026-10-31', stichworte: ' \n ' },
      'stichworte',
    ],
    [
      'a text of hidden characters only',
      {
        samstag: '2026-10-31',
        stichworte: String.fromCodePoint(0x200b, 0xe0041),
      },
      'stichworte',
    ],
    [
      'a text that is too long',
      { samstag: '2026-10-31', stichworte: 'a'.repeat(21) },
      'stichworte',
    ],
  ] as const)('refuses %s and names the argument', (_, values, name) => {
    expect(filled(values)).toEqual({ ok: false, argument: name });
  });

  it.each([
    ['no object', 'samstag=2026-10-31'],
    ['an array', ['2026-10-31', 'Kaffee']],
    ['no values for a prompt with arguments', undefined],
    [
      'a name the prompt does not have',
      { samstag: '2026-10-31', stichworte: 'Kaffee', sonntag: 'x' },
    ],
    [
      'a value behind a getter',
      Object.defineProperty({ stichworte: 'Kaffee' }, 'samstag', {
        enumerable: true,
        get: () => '2026-10-31',
      }),
    ],
  ] as const)('refuses %s without naming what the client sent', (_, values) => {
    const result = filled(values);
    if (values === undefined) {
      expect(result).toEqual({ ok: false, argument: 'samstag' });
    } else {
      expect(result).toEqual({ ok: false, argument: undefined });
    }
  });

  it('removes hidden characters, turns CR LF into LF and trims a text', () => {
    const hidden = String.fromCodePoint(0x200b, 0xe0041, 0x202e);
    const result = filled({
      samstag: '2026-10-31',
      stichworte: `  Kaf${hidden}fee\r\nKu\rchen \n`,
    });
    expect(result.ok && result.text).toContain(
      'Stichworte:\nKaffee\nKuchen\n\nAm',
    );
  });

  it('counts the length after the cleaning', () => {
    const hidden = String.fromCodePoint(0x200b).repeat(30);
    expect(
      filled({
        samstag: '2026-10-31',
        stichworte: `${'a'.repeat(20)}${hidden}`,
      }),
    ).toMatchObject({ ok: true });
  });

  it('takes a Saturday as a Saturday, also on a leap day and at the end of a year', () => {
    for (const day of [
      '2024-03-02',
      '2028-01-01',
      '2033-12-31',
      '9999-12-25',
    ]) {
      expect(filled({ samstag: day, stichworte: 'Kaffee' }), day).toMatchObject(
        { ok: true },
      );
    }
  });

  it('takes any day when the argument names no weekday', () => {
    const entry = checkPrompt(
      {
        ...valid,
        arguments: [{ name: 'tag', description: 'Ein Tag.', kind: 'date' }],
        text: 'Am {tag}.',
      },
      'example',
      'plugin',
    );
    expect(entry.fill({ tag: '2026-10-28' })).toMatchObject({ ok: true });
  });
});

describe('prompts in the catalog', () => {
  const core = plugin(
    'test-core',
    adding([tool('ct_wiki_read'), tool('ct_events_read', 'events')], []),
  );

  it('lists the prompts sorted by name, frozen, and finds one by name', () => {
    const catalog = createToolCatalog({
      core,
      plugins: [
        plugin(
          'example',
          adding(
            [],
            [
              { ...valid, name: 'zweiter' },
              { ...valid, name: 'erster' },
            ],
          ),
        ),
      ],
      readOnly: true,
      toolsets: new Set(['wiki']),
    });
    expect(catalog.prompts().map((p) => p.name)).toEqual(['erster', 'zweiter']);
    expect(Object.isFrozen(catalog.prompts())).toBe(true);
    expect(catalog.prompt('erster')?.origin).toBe('plugin');
    expect(catalog.prompt('dritter')).toBeUndefined();
    expect(catalog.prompt('__proto__')).toBeUndefined();
  });

  it('offers a prompt only while it offers every one of its tools', () => {
    const both = {
      ...valid,
      name: 'beide',
      tools: ['ct_wiki_read', 'ct_events_read'],
    };
    const catalogWith = (toolsets: ReadonlySet<'wiki' | 'events'>) =>
      createToolCatalog({
        core,
        plugins: [plugin('example', adding([], [valid, both]))],
        readOnly: true,
        toolsets,
      });
    expect(catalogWith(new Set()).prompts()).toEqual([]);
    expect(
      catalogWith(new Set(['wiki']))
        .prompts()
        .map((p) => p.name),
    ).toEqual(['wochenende']);
    expect(
      catalogWith(new Set(['wiki', 'events']))
        .prompts()
        .map((p) => p.name),
    ).toEqual(['beide', 'wochenende']);
    expect(catalogWith(new Set(['events'])).prompt('beide')).toBeUndefined();
  });

  it('leaves out a prompt that relies on a write tool while the server only reads', () => {
    const writing = plugin(
      'test-core',
      adding(
        [tool('ct_wiki_write', 'wiki', 'write')],
        [{ ...valid, tools: ['ct_wiki_write'] }],
      ),
    );
    const options = {
      core: writing,
      plugins: [],
      toolsets: new Set(['wiki'] as const),
    };
    expect(createToolCatalog({ ...options, readOnly: true }).prompts()).toEqual(
      [],
    );
    expect(
      createToolCatalog({ ...options, readOnly: false })
        .prompts()
        .map((p) => p.name),
    ).toEqual(['wochenende']);
  });

  it('takes a prompt of a plugin that relies on a tool of the core', () => {
    const catalog = createToolCatalog({
      core,
      plugins: [plugin('example', adding([], [valid]))],
      readOnly: true,
      toolsets: new Set(['wiki']),
    });
    expect(catalog.prompt('wochenende')?.plugin).toBe('example');
  });

  it('refuses a prompt that relies on a tool no plugin added, also when its toolset is off', () => {
    for (const toolsets of [new Set<'wiki'>(), new Set(['wiki'] as const)]) {
      const refusal = refusalOf(() =>
        createToolCatalog({
          core,
          plugins: [
            plugin(
              'example',
              adding([], [{ ...valid, tools: ['ct_wiki_read', 'ct_missing'] }]),
            ),
          ],
          readOnly: true,
          toolsets,
        }),
      );
      expect([refusal.reason, refusal.plugin, refusal.prompt]).toEqual([
        'prompt_tools',
        'example',
        'wochenende',
      ]);
    }
  });

  it('refuses a name twice, in one plugin and across plugins', () => {
    for (const plugins of [
      [plugin('example', adding([], [valid, valid]))],
      [
        plugin('example', adding([], [valid])),
        plugin('other', adding([], [valid])),
      ],
    ]) {
      const refusal = refusalOf(() =>
        createToolCatalog({ core, plugins, readOnly: true }),
      );
      expect([refusal.reason, refusal.prompt]).toEqual([
        'prompt_duplicate',
        'wochenende',
      ]);
    }
  });

  it('refuses a prompt added after register returned', () => {
    let kept: PluginHost | undefined;
    const catalog = createToolCatalog({
      core,
      plugins: [
        plugin('example', (host) => {
          kept = host;
          return undefined;
        }),
      ],
      readOnly: true,
      toolsets: new Set(['wiki']),
    });
    const refusal = refusalOf(() => kept?.addPrompt(valid));
    expect(refusal.reason).toBe('host_revoked');
    expect(catalog.prompts()).toEqual([]);
  });

  it('keeps the refusal of a prompt when the plugin catches it and goes on', () => {
    const refusal = refusalOf(() =>
      createToolCatalog({
        core,
        plugins: [
          plugin('example', (host) => {
            try {
              host.addPrompt({ ...valid, name: 'Falsch' });
            } catch {
              // goes on as if nothing happened
            }
            host.addPrompt(valid);
            return undefined;
          }),
        ],
        readOnly: true,
      }),
    );
    expect(refusal.reason).toBe('prompt_name');
  });

  it('turns any other error of a check into a refusal of the prompt', () => {
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('Böse\nZeile');
        },
      },
    );
    const refusal = refusalOf(() =>
      createToolCatalog({
        core,
        plugins: [plugin('example', adding([], [throwing]))],
        readOnly: true,
      }),
    );
    expect(refusal.reason).toBe('prompt_invalid');
    expect(refusal.message).not.toContain('Böse');
  });
});
