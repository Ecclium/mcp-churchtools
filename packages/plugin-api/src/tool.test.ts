import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  type ApiOperation,
  type ApiOperationResult,
  classify,
  defineTool,
  type ObjectSchema,
  type Permissions,
  type Plugin,
  type PluginHost,
  type ReadApi,
  type RightValue,
  type Sensitivity,
  type ToolCall,
  type ToolDefinition,
  type ToolDescription,
  type ToolMeta,
} from './index.js';

// Most of these are type tests: the type check of the tests fails when a
// line marked with @ts-expect-error compiles.

const readMeta = {
  capability: 'read',
  domain: 'persons',
  requiredRights: [{ module: 'churchdb', right: 'view alldata' }],
  tier: 'free',
  sensitivity: 'special',
  unattended: 'never',
  routineStable: false,
} as const satisfies ToolMeta;

const description: ToolDescription = {
  purpose: 'Finds persons by name.',
  useWhen: 'When the user asks for a person by name.',
  avoidWhen: 'To list all persons; there is no tool for that.',
  limits: 'At most 50 results, no paging.',
};

const toolSpec = {
  name: 'ct_persons_search',
  meta: readMeta,
  description,
  input: z.object({ query: z.string().min(2) }),
  output: z.object({
    persons: z.array(
      z.object({
        id: classify(z.number().int(), 'personId'),
        firstName: classify(z.string(), 'name.first'),
        lastName: classify(z.string(), 'name.last'),
      }),
    ),
  }),
  execute: ({ input }: ToolCall<{ query: string }>) => {
    expectTypeOf(input).toEqualTypeOf<{ query: string }>();
    return Promise.resolve({ persons: [] });
  },
} as const;
const tool = defineTool(toolSpec);

describe('ToolMeta', () => {
  it('keeps a tool with special data from running unattended', () => {
    // @ts-expect-error: special data never runs without a person
    const meta: ToolMeta = { ...readMeta, unattended: 'policy' };
    expect(meta).toBeTypeOf('object');
  });

  it('lets other tools follow a policy when unattended', () => {
    const meta: ToolMeta = {
      ...readMeta,
      sensitivity: 'none',
      unattended: 'policy',
    };
    expect(meta.unattended).toBe('policy');
  });

  it('requires a replay guard and reversibility for a write tool', () => {
    // @ts-expect-error: a write without replay guard could take effect twice
    const noGuard: ToolMeta = {
      ...readMeta,
      capability: 'write',
      reversible: 'snapshot',
    };
    // @ts-expect-error: a write must say whether it can be undone
    const noReversible: ToolMeta = {
      ...readMeta,
      capability: 'write',
      replayGuard: 'nonce',
    };
    expect([noGuard, noReversible]).toHaveLength(2);
  });

  it('accepts a complete write tool', () => {
    const meta: ToolMeta = {
      ...readMeta,
      capability: 'write',
      reversible: 'snapshot',
      replayGuard: 'nonce',
    };
    expect(meta.capability).toBe('write');
  });

  it('has no replay guard on a read tool', () => {
    // Not a fresh object literal, so the check for excess properties does
    // not apply; only the type of ReadToolMeta refuses the field.
    const withGuard = { ...readMeta, replayGuard: 'nonce' as const };
    // @ts-expect-error: only writes have a replay guard
    const meta: ToolMeta = withGuard;
    expect(meta).toBeTypeOf('object');
  });
});

describe('ToolDescription', () => {
  it('requires every section', () => {
    // @ts-expect-error: when not to use the tool is a required section
    const missing: ToolDescription = {
      purpose: description.purpose,
      useWhen: description.useWhen,
      limits: description.limits,
    };
    expect(missing).toBeTypeOf('object');
  });
});

describe('ToolDefinition and defineTool', () => {
  const base = {
    name: 'ct_base_example',
    meta: readMeta,
    description,
    input: z.object({ query: z.string() }),
  } as const;
  const output = z.object({
    a: classify(z.string(), 'none'),
    b: classify(z.string(), 'none'),
  });

  it('returns the tool unchanged', () => {
    const spec = {
      ...base,
      output,
      execute: () => Promise.resolve({ a: 'x', b: 'y' }),
    };
    expect(defineTool(spec)).toBe(spec);
  });

  it('takes the types of input and output from the schemas', () => {
    expectTypeOf(tool).toEqualTypeOf<
      ToolDefinition<
        { query: string },
        { persons: { id: number; firstName: string; lastName: string }[] }
      >
    >();
  });

  // Undeclared fields of a result are not a type error: the pipeline checks
  // the result against the output schema at run time.
  it('refuses a result of another type', () => {
    defineTool({
      ...toolSpec,
      // @ts-expect-error: persons is a list, not a string
      execute: () => Promise.resolve({ persons: 'none' }),
    });
    expect(tool.name).toBe('ct_persons_search');
  });

  it('refuses a result that lacks a field of the output schema', () => {
    defineTool({
      ...base,
      output,
      // @ts-expect-error: the field b is missing
      execute: () => Promise.resolve({ a: 'x' }),
    });
    expect(output.shape).toHaveProperty('b');
  });

  it('refuses the same from an async function without a declared type', () => {
    defineTool({
      ...base,
      output,
      // @ts-expect-error: the field b is missing
      execute: async () => {
        await Promise.resolve();
        return { a: 'x' };
      },
    });
    expect(output.shape).toHaveProperty('a');
  });

  it('refuses a handler that expects more input than the schema gives', () => {
    const handler = (
      call: ToolCall<{ query: string; limit: number }>,
    ): Promise<{ a: string; b: string }> =>
      Promise.resolve({ a: call.input.query, b: String(call.input.limit) });
    defineTool({
      ...base,
      output,
      // @ts-expect-error: the input schema has no field limit
      execute: handler,
    });
    expect(handler).toBeTypeOf('function');
  });

  it('expects the result before the output schema transforms it', () => {
    const counted = z.object({ n: z.string().transform((s) => s.length) });
    defineTool({
      ...base,
      output: counted,
      execute: () => Promise.resolve({ n: 'text' }),
    });
    defineTool({
      ...base,
      output: counted,
      // @ts-expect-error: the pipeline parses the result, so it gets the text
      execute: () => Promise.resolve({ n: 4 }),
    });
    expect(counted.parse({ n: 'text' })).toEqual({ n: 4 });
  });

  it('refuses schemas of input and result that are not objects', () => {
    defineTool({
      ...base,
      // @ts-expect-error: MCP takes only an object as input
      input: z.string(),
      output,
      execute: () => Promise.resolve({ a: 'x', b: 'y' }),
    });
    defineTool({
      ...base,
      // @ts-expect-error: a structured result is an object
      output: z.array(z.string()),
      execute: () => Promise.resolve({ a: 'x', b: 'y' }),
    });
    expect(base.input.shape).toHaveProperty('query');
  });

  it('takes only objects as schemas of input and result', () => {
    expectTypeOf(base.input).toExtend<ObjectSchema>();
    expectTypeOf(z.string()).not.toExtend<ObjectSchema>();
    expectTypeOf(z.array(z.string())).not.toExtend<ObjectSchema>();
    expectTypeOf(
      z.object({ n: z.string().transform((s) => s.length) }),
    ).toExtend<ObjectSchema>();
    expect(base.input.shape).toHaveProperty('query');
  });

  it('refuses a name without the prefix ct_', () => {
    // @ts-expect-error: every tool name starts with ct_
    defineTool({ ...toolSpec, name: 'persons_search' });
    expect(tool.name.startsWith('ct_')).toBe(true);
  });

  it('gives execute only context, input and read access', () => {
    expectTypeOf<keyof ToolCall<unknown>>().toEqualTypeOf<
      'ctx' | 'input' | 'read'
    >();
  });
});

describe('ReadApi', () => {
  it('holds the account, its rights, persons and groups, the wiki, events, services, calendars, resources, songs, the searches and the escape hatch only', () => {
    expectTypeOf<keyof ReadApi>().toEqualTypeOf<
      | 'whoami'
      | 'permissions'
      | 'searchPersons'
      | 'searchGroups'
      | 'person'
      | 'personGroups'
      | 'group'
      | 'groupMembers'
      | 'wikiCategories'
      | 'wikiPages'
      | 'wikiPage'
      | 'events'
      | 'event'
      | 'eventAgenda'
      | 'services'
      | 'eventAssignments'
      | 'calendars'
      | 'appointments'
      | 'appointment'
      | 'resources'
      | 'bookings'
      | 'searchSongs'
      | 'song'
      | 'searchWiki'
      | 'search'
      | 'operations'
      | 'operation'
    >();
  });

  it('gives the sensitivity of an operation of the escape hatch in the values of Sensitivity', () => {
    expectTypeOf<ApiOperation['sensitivity']>().toEqualTypeOf<Sensitivity>();
    expectTypeOf<
      ApiOperationResult['sensitivity']
    >().toEqualTypeOf<Sensitivity>();
  });

  it('holds only set rights, or unknown', () => {
    // @ts-expect-error: a right that is not set is left out, not false
    const unset: RightValue = false;
    expectTypeOf<Permissions['kind']>().toEqualTypeOf<'known' | 'unknown'>();
    expect(unset).toBe(false);
  });
});

describe('Plugin and PluginHost', () => {
  it('use no name of the registration functions of the MCP SDK', () => {
    expectTypeOf<keyof PluginHost>().toEqualTypeOf<'addTool' | 'addPrompt'>();
    expectTypeOf<keyof Plugin>().toEqualTypeOf<
      'name' | 'version' | 'register'
    >();
  });

  it('refuse a plugin that registers asynchronously', () => {
    const plugin: Plugin = {
      name: 'example',
      version: '0.0.0',
      // @ts-expect-error: the host is frozen once register returns
      register: async (target) => {
        await Promise.resolve();
        target.addTool(tool);
      },
    };
    expect(plugin.name).toBe('example');
  });

  it('accept a tool through the host', () => {
    const added: string[] = [];
    const host: PluginHost = {
      addTool: (definition) => {
        added.push(definition.name);
      },
      addPrompt: (prompt) => {
        added.push(prompt.name);
      },
    };
    const plugin: Plugin = {
      name: 'example',
      version: '0.0.0',
      register: (target) => {
        target.addTool(tool);
      },
    };
    plugin.register(host);
    expect(added).toEqual(['ct_persons_search']);
  });
});
