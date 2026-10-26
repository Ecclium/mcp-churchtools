import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  maxPromptArgumentDescriptionLength,
  maxPromptArguments,
  maxPromptDescriptionLength,
  maxPromptTextArgumentLength,
  maxPromptTextLength,
  maxPromptTitleLength,
  maxPromptTools,
  type PromptArgument,
  promptArgumentNamePattern,
  type PromptDefinition,
  promptNamePattern,
} from './index.js';

// Most of these are type tests: the type check of the tests fails when a
// line marked with @ts-expect-error compiles.

const prompt = {
  name: 'dienstplan_wochenende',
  title: 'Dienstplan-Überblick für ein Wochenende',
  description: 'Fasst den Dienstplan eines Wochenendes zusammen.',
  tools: ['ct_events_list'],
  arguments: [
    {
      name: 'samstag',
      description: 'Samstag im Format JJJJ-MM-TT.',
      kind: 'date',
      weekday: 6,
    },
  ],
  text: 'Überblick für das Wochenende ab {samstag}.',
} as const satisfies PromptDefinition;

describe('the names of prompts and arguments', () => {
  it.each([
    ['dienstplan_wochenende', true],
    ['a', true],
    ['a'.repeat(63), true],
    ['a'.repeat(64), false],
    ['Dienstplan', false],
    ['1dienstplan', false],
    ['_dienstplan', false],
    ['dienstplan-wochenende', false],
    ['dienstplan wochenende', false],
    ['', false],
  ])('takes %j as a prompt name: %s', (name, fits) => {
    expect(promptNamePattern.test(name)).toBe(fits);
  });

  it.each([
    ['samstag', true],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['Samstag', false],
    ['sam-stag', false],
    ['2tag', false],
  ])('takes %j as an argument name: %s', (name, fits) => {
    expect(promptArgumentNamePattern.test(name)).toBe(fits);
  });

  it('carries no flag that would share a lastIndex', () => {
    expect(promptNamePattern.flags).toBe('');
    expect(promptArgumentNamePattern.flags).toBe('');
  });
});

describe('the limits of prompts', () => {
  it('has the values the reference names', () => {
    expect({
      maxPromptTitleLength,
      maxPromptDescriptionLength,
      maxPromptArgumentDescriptionLength,
      maxPromptTextLength,
      maxPromptArguments,
      maxPromptTools,
      maxPromptTextArgumentLength,
    }).toEqual({
      maxPromptTitleLength: 100,
      maxPromptDescriptionLength: 500,
      maxPromptArgumentDescriptionLength: 300,
      maxPromptTextLength: 8000,
      maxPromptArguments: 5,
      maxPromptTools: 10,
      maxPromptTextArgumentLength: 2000,
    });
  });
});

describe('PromptDefinition', () => {
  it('has the fields of a prompt and no code', () => {
    expectTypeOf<keyof PromptDefinition>().toEqualTypeOf<
      'name' | 'title' | 'description' | 'tools' | 'arguments' | 'text'
    >();
    expect(prompt.name).toBe('dienstplan_wochenende');
  });

  it('takes only names of tools for the tools', () => {
    const wrong = {
      ...prompt,
      // @ts-expect-error: every tool name starts with ct_
      tools: ['events_list'],
    } satisfies PromptDefinition;
    expect(wrong.tools).toHaveLength(1);
  });

  it('knows the kinds date and text, and a text needs its longest value', () => {
    expectTypeOf<PromptArgument['kind']>().toEqualTypeOf<'date' | 'text'>();
    const text: PromptArgument = {
      name: 'stichworte',
      description: 'Stichworte.',
      kind: 'text',
      maxLength: 2000,
    };
    // @ts-expect-error: an argument of the kind text names its maxLength
    const short: PromptArgument = {
      name: 'stichworte',
      description: 'Stichworte.',
      kind: 'text',
    };
    const day: PromptArgument = {
      name: 'samstag',
      description: 'Samstag.',
      kind: 'date',
      // @ts-expect-error: a weekday counts from 1 to 7
      weekday: 0,
    };
    expect([text.kind, short.kind, day.kind]).toEqual(['text', 'text', 'date']);
  });
});
