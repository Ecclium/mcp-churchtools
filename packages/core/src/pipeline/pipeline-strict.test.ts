import { createHash } from 'node:crypto';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  type KeyProvider,
  type Plugin,
  type PluginHost,
  type RedactionLevel,
  refersTo,
  type TenantAssignment,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  makeCanary,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { fixedSentences } from '../errors/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { freeTextMarkers } from '../redaction/index.js';
import { pseudonymLength, pseudonymPrefix } from '../redaction/pseudonym.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// The level strict in the pipeline (ADR 0069): pseudonyms in place of the
// IDs of persons in input and output, the tool sees IDs only, the audit
// records IDs only, and the keys of each call are erased when it ends.

// The pseudonyms of the pipeline, watched: each erase is counted, and a
// test can make hide or erase throw.
const watch = vi.hoisted(() => ({
  erased: 0,
  opened: 0,
  failHide: false,
  failErase: false,
}));

vi.mock('../redaction/pseudonym.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../redaction/pseudonym.js')>();
  return {
    ...original,
    openPseudonyms: async (
      ...args: Parameters<typeof original.openPseudonyms>
    ) => {
      const pseudonyms = await original.openPseudonyms(...args);
      watch.opened += 1;
      return Object.freeze({
        hide: (id: number) => {
          if (watch.failHide) throw new TypeError('hide');
          return pseudonyms.hide(id);
        },
        reveal: pseudonyms.reveal,
        erase: () => {
          watch.erased += 1;
          pseudonyms.erase();
          if (watch.failErase) throw new TypeError('erase');
        },
      });
    },
  };
});

beforeEach(() => {
  Object.assign(watch, {
    erased: 0,
    opened: 0,
    failHide: false,
    failErase: false,
  });
});

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

// A test key from a seed, never written out as hex.
const keys = (seed: string): KeyProvider =>
  createFileKeyProvider({
    current: new KeyMaterial(createHash('sha256').update(seed).digest('hex')),
  });

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const meta = {
  capability: 'read',
  domain: 'wiki',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'special',
  unattended: 'never',
  routineStable: false,
} as const;

const id = () => z.number().int().nonnegative();

// What the tools saw of their input, for the tests.
const seen: unknown[] = [];

// Lists two persons with their last names and a note of free text.
const listTool = {
  name: 'ct_test_people',
  meta,
  description,
  input: z.strictObject({}),
  output: z.object({
    people: z
      .array(
        z.object({
          id: classify(id(), 'personId'),
          lastName: classify(z.string().max(50), 'name.last'),
        }),
      )
      .max(5),
    note: classify(z.string().max(200), 'untrusted'),
  }),
  execute: () =>
    Promise.resolve({
      people: [
        { id: 12, lastName: 'Mustermann' },
        { id: 13, lastName: 'Musterfrau' },
      ],
      note: 'Kontakt: max.mustermann@example.org',
    }),
} as unknown as ToolDefinition;

// Reads one person by ID and gives the ID back.
const getTool = {
  name: 'ct_test_person',
  meta,
  description,
  input: z.strictObject({
    personId: classify(id(), 'personId'),
    eventId: refersTo(id(), 'event').optional(),
  }),
  output: z.object({ id: classify(id(), 'personId') }),
  execute: ({ input }: { readonly input: { personId: number } }) => {
    seen.push(input);
    return Promise.resolve({ id: input.personId });
  },
} as unknown as ToolDefinition;

// Takes persons in a list, in a record, in a tuple and in a choice whose
// options both name the same place.
const shapesTool = {
  name: 'ct_test_shapes',
  meta,
  description,
  input: z.strictObject({
    list: z.array(classify(id(), 'personId')).max(3).optional(),
    byName: z.record(z.string(), classify(id(), 'personId')).optional(),
    pair: z
      .tuple([classify(id(), 'personId'), classify(z.string(), 'none')])
      .optional(),
    either: z
      .union([
        z.strictObject({
          personId: classify(id(), 'personId'),
          a: classify(z.string(), 'none'),
        }),
        z.strictObject({
          personId: classify(id(), 'personId'),
          b: classify(z.string(), 'none'),
        }),
      ])
      .optional(),
    other: z
      .union([
        z.strictObject({ personId: classify(id(), 'personId') }),
        z.strictObject({ personId: classify(id(), 'none') }),
      ])
      .optional(),
  }),
  output: z.object({ done: classify(z.boolean(), 'none') }),
  execute: ({ input }: { readonly input: unknown }) => {
    seen.push(input);
    return Promise.resolve({ done: true });
  },
} as unknown as ToolDefinition;

// Names no person anywhere.
const plainTool = {
  name: 'ct_test_plain',
  meta: { ...meta, sensitivity: 'none', unattended: 'policy' },
  description,
  input: z.strictObject({ page: classify(z.number().int(), 'none') }),
  output: z.object({ text: classify(z.string().max(200), 'untrusted') }),
  execute: () =>
    Promise.resolve({ text: 'IBAN und Telefon 000 000 12 34 im Text' }),
} as unknown as ToolDefinition;

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    for (const tool of [listTool, getTool, shapesTool, plainTool]) {
      host.addTool(tool);
    }
    return undefined;
  },
};

const request = (
  options: {
    readonly redaction?: RedactionLevel;
    readonly mode?: ToolRequest['mode'];
    readonly subject?: string;
  } = {},
): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: `stdio:${options.subject ?? 'local-stdio'}` },
  } as unknown as TenantAssignment,
  mode: options.mode ?? 'interactive',
  redaction: options.redaction ?? 'strict',
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const setup = (options: { readonly keys?: KeyProvider | 'none' } = {}) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });
  const fileLines: string[] = [];
  const stderr: string[] = [];
  const writer = Object.freeze({
    write: (line: string) => {
      stderr.push(line);
      return true;
    },
  });
  const clock = Object.freeze({
    now: Object.freeze(() => Date.UTC(2026, 9, 31, 12)),
  });
  const audit = createAuditSink({
    writer,
    file: {
      write: (line) => {
        fileLines.push(line);
        return true;
      },
      ready: () => true,
    },
    clock,
    isKnownTool: catalog.has,
  });
  const provider =
    options.keys === 'none' ? undefined : (options.keys ?? keys('seed-a'));
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog,
    audit,
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer, minLevel: 'debug' },
    ...(provider === undefined ? {} : { keys: provider }),
  });
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    call: (
      name: string,
      input: unknown,
      more?: Parameters<typeof request>[0],
    ) => pipeline.call(name, input, request(more)),
    inFile: () => fileLines.map(parse),
    stderr: () => stderr.join('\n'),
  };
};

const isPseudonym = (value: unknown): boolean =>
  typeof value === 'string' &&
  value.length === pseudonymLength &&
  value.startsWith(pseudonymPrefix);

// The pseudonyms of the persons 12 and 13 for the principal of a call.
const pseudonymsOf = async (
  call: ReturnType<typeof setup>['call'],
  subject?: string,
): Promise<string[]> => {
  const outcome = await call(
    'ct_test_people',
    {},
    subject === undefined ? {} : { subject },
  );
  if (!outcome.ok) throw new Error('the list failed');
  return (outcome.data.people as { id: string }[]).map((person) => person.id);
};

afterEach(() => {
  seen.length = 0;
});

describe('the level strict in the pipeline', () => {
  it('gives pseudonyms and short last names, checks free text and records IDs', async () => {
    const { call, inFile, stderr } = setup();
    const outcome = await call('ct_test_people', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const people = outcome.data.people as {
      id: string;
      lastName: string;
    }[];
    expect(people.map((person) => isPseudonym(person.id))).toEqual([
      true,
      true,
    ]);
    expect(people[0]?.id).not.toBe(people[1]?.id);
    expect(people.map((person) => person.lastName)).toEqual(['M.', 'M.']);
    expect(outcome.data.note).toContain(freeTextMarkers.email);
    expect(inFile()).toMatchObject([
      { outcome: 'ok', objectRefs: ['person:12', 'person:13'] },
    ]);
    expect(JSON.stringify(inFile())).not.toContain(pseudonymPrefix);
    expect(stderr()).not.toContain(pseudonymPrefix);
  });

  it('turns a pseudonym of the input into the ID the tool sees, and back', async () => {
    const { call, inFile } = setup();
    const [first] = await pseudonymsOf(call);
    const outcome = await call('ct_test_person', {
      personId: first,
      eventId: 9,
    });
    expect(outcome.ok && outcome.data).toEqual({ id: first });
    expect(seen).toEqual([{ personId: 12, eventId: 9 }]);
    expect(inFile()[1]).toMatchObject({
      outcome: 'ok',
      objectRefs: ['person:12', 'event:9'],
    });
  });

  it('refuses a raw ID, a changed pseudonym and one of another principal', async () => {
    const { call, inFile } = setup();
    const [first = ''] = await pseudonymsOf(call);
    const [ofOther = ''] = await pseudonymsOf(call, 'other-person');
    const changed = `${first.slice(0, -2)}${first.endsWith('aa') ? 'ba' : 'aa'}`;
    for (const personId of [12, changed, ofOther, 'p1_']) {
      const outcome = await call('ct_test_person', { personId });
      expect(!outcome.ok && outcome.error, String(personId)).toEqual({
        code: 'validation',
        message:
          'IDs of persons on this server are pseudonyms that start with p1_. Pass them on as a tool returned them.',
      });
    }
    expect(seen).toEqual([]);
    // The raw ID a model tried is named, a pseudonym that did not open not.
    expect(inFile().slice(2)).toMatchObject([
      { errorCode: 'validation', objectRefs: ['person:12'] },
      { errorCode: 'validation', objectRefs: [] },
      { errorCode: 'validation', objectRefs: [] },
      { errorCode: 'validation', objectRefs: [] },
    ]);
  });

  it('refuses an input beyond the limits before it looks for pseudonyms', async () => {
    const { call } = setup();
    let deep: unknown = 'p1_';
    for (let level = 0; level < 20; level += 1) deep = [deep];
    const outcome = await call('ct_test_person', { personId: deep });
    expect(!outcome.ok && outcome.error).toEqual({
      code: 'validation',
      message: fixedSentences.validation,
    });
    expect(seen).toEqual([]);
  });

  it('takes no pseudonym in standard, and gives numbers there', async () => {
    const { call } = setup();
    const [first] = await pseudonymsOf(call);
    const refused = await call(
      'ct_test_person',
      { personId: first },
      { redaction: 'standard' },
    );
    expect(!refused.ok && refused.error.code).toBe('validation');
    const plain = await call(
      'ct_test_person',
      { personId: 12 },
      { redaction: 'standard' },
    );
    expect(plain.ok && plain.data).toEqual({ id: 12 });
  });

  it('names the IDs of the input of a call the gate refuses', async () => {
    const { call, inFile } = setup();
    const [first] = await pseudonymsOf(call);
    const outcome = await call(
      'ct_test_person',
      { personId: first },
      { mode: 'unattended' },
    );
    expect(!outcome.ok && outcome.error.code).toBe('policy_denied');
    expect(inFile()[1]).toMatchObject({
      outcome: 'denied',
      objectRefs: ['person:12'],
    });
  });

  it('finds the persons in lists, records, tuples and choices', async () => {
    const { call } = setup();
    const [first = '', second = ''] = await pseudonymsOf(call);
    const outcome = await call('ct_test_shapes', {
      list: [first, second],
      byName: { a: second },
      pair: [first, 'text'],
      either: { personId: second, b: 'x' },
      other: { personId: first },
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([
      {
        list: [12, 13],
        byName: { a: 13 },
        pair: [12, 'text'],
        either: { personId: 13, b: 'x' },
        other: { personId: 12 },
      },
    ]);
  });

  it('lets no raw ID through another option of a choice', async () => {
    const { call } = setup();
    for (const input of [
      { other: { personId: 12 } },
      { list: [12] },
      { byName: { a: 12 } },
      { pair: [12, 'text'] },
    ]) {
      const outcome = await call('ct_test_shapes', input);
      expect(!outcome.ok && outcome.error.code, JSON.stringify(input)).toBe(
        'validation',
      );
    }
    expect(seen).toEqual([]);
  });

  it('erases the keys after every call, also after a failure', async () => {
    const { call } = setup();
    const [first] = await pseudonymsOf(call);
    await call('ct_test_person', { personId: first });
    await call('ct_test_person', { personId: 12 });
    await call('ct_test_person', { personId: first }, { mode: 'unattended' });
    expect(watch.opened).toBe(4);
    expect(watch.erased).toBe(4);
  });

  it('asks no key for a tool without an ID of a person, but checks its free text', async () => {
    const dataKeys = vi.fn<KeyProvider['dataKeys']>();
    const { call } = setup({ keys: { dataKeys } });
    const outcome = await call('ct_test_plain', { page: 1 });
    expect(outcome.ok && outcome.data.text).toContain(freeTextMarkers.phone);
    expect(dataKeys).not.toHaveBeenCalled();
    expect(watch.opened).toBe(0);
  });

  it('ends a call with internal without a provider or when it fails', async () => {
    const failing: KeyProvider = {
      dataKeys: () => Promise.reject(new Error('no key')),
    };
    for (const provider of ['none', failing] as const) {
      const { call, inFile, stderr } = setup({ keys: provider });
      const outcome = await call('ct_test_people', {});
      expect(!outcome.ok && outcome.error.code).toBe('internal');
      expect(inFile()).toMatchObject([{ errorCode: 'internal' }]);
      expect(stderr()).toContain('"event":"pseudonym_keys_unavailable"');
    }
    // The gate still decides first.
    const { call } = setup({ keys: 'none' });
    const refused = await call('ct_test_people', {}, { mode: 'unattended' });
    expect(!refused.ok && refused.error.code).toBe('policy_denied');
  });

  it('gives no ID without its pseudonym, and goes on when erasing throws', async () => {
    const { call, inFile, stderr } = setup();
    watch.failHide = true;
    const outcome = await call('ct_test_people', {});
    expect(!outcome.ok && outcome.error.code).toBe('internal');
    expect(stderr()).toContain('"event":"tool_pseudonym_failed"');
    // A result that does not go out names no person of it in the audit.
    expect(inFile()[0]).toMatchObject({
      errorCode: 'internal',
      objectRefs: [],
    });
    watch.failHide = false;
    watch.failErase = true;
    const listed = await call('ct_test_people', {});
    expect(listed.ok).toBe(true);
  });
});
