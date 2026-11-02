/**
 * Example of a plugin as a third party would write it. It imports nothing
 * but the plugin API and zod, which a plugin brings itself. That shows the
 * plugin API alone is enough to write a plugin (ADR 0022).
 *
 * Its tools serve the tests of registry and pipeline: one reads the account
 * through the read access of a call, one returns its input in fields of
 * every class that redaction and the data envelope treat, one plans a
 * section of a wiki page, and one plans a write of the Pro module, which
 * the core refuses until it runs such writes (ADR 0029, ADR 0071).
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  defineWriteTool,
  type Plugin,
  type PluginHost,
  refersTo,
  wikiPageGuidPattern,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

/** Reads the account the server reads ChurchTools with. */
export const exampleProfileTool = defineTool({
  name: 'ct_example_profile',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose: 'Reads the account the server uses in ChurchTools.',
    useWhen: 'A test needs a tool that reads through the core.',
    avoidWhen: 'You need anything else; this tool exists for tests.',
    limits: 'Returns one account.',
  },
  input: z.object({}),
  output: z.object({
    id: classify(z.number().int(), 'personId'),
    firstName: classify(z.string().max(255), 'name.first'),
    lastName: classify(z.string().max(255), 'name.last'),
    email: classify(z.string().max(254), 'email').nullable(),
  }),
  execute: async ({ read }) => {
    const me = await read.whoami();
    return {
      id: me.id,
      firstName: me.firstName,
      lastName: me.lastName,
      email: me.email,
    };
  },
});

const text = (max: number) => z.string().max(max);

/** Returns its input in fields of each class redaction treats. */
export const exampleEchoTool = defineTool({
  name: 'ct_example_echo',
  meta: {
    capability: 'read',
    domain: 'wiki',
    requiredRights: [],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'never',
    routineStable: false,
  },
  description: {
    purpose: 'Returns its input in fields of known data classes.',
    useWhen: 'A test needs output with contact data and free text.',
    avoidWhen: 'You need anything else; this tool exists for tests.',
    limits: 'At most 50 notes per call.',
  },
  input: z.strictObject({
    email: classify(text(254), 'email').optional(),
    phone: classify(text(50), 'phone').optional(),
    birthdate: classify(text(10), 'birthdate').optional(),
    notes: z
      .array(classify(text(2000), 'none'))
      .max(50)
      .optional(),
  }),
  output: z.object({
    email: classify(text(254), 'email').optional(),
    phone: classify(text(50), 'phone').optional(),
    birthdate: classify(text(10), 'birthdate').optional(),
    notes: z
      .array(classify(text(2000), 'untrusted'))
      .max(50)
      .optional(),
  }),
  execute: ({ input }) => Promise.resolve(input),
});

/**
 * Plans a section at the end of a wiki page. It only plans: the core seals
 * the plan, gets it confirmed and commits it.
 */
export const exampleWriteTool = defineWriteTool({
  name: 'ct_example_note_write',
  meta: {
    capability: 'write',
    domain: 'wiki',
    requiredRights: [{ module: 'churchwiki', right: 'edit category' }],
    tier: 'free',
    sensitivity: 'personal',
    unattended: 'policy',
    routineStable: false,
    reversible: 'snapshot',
    replayGuard: 'marker',
  },
  description: {
    purpose: 'Adds a note as a section at the end of a wiki page.',
    useWhen: 'A test needs a write tool.',
    avoidWhen: 'You want to change the text of a page; use another tool.',
    limits: 'Markdown pages only; the note is at most 200 characters.',
  },
  input: z.strictObject({
    categoryId: refersTo(z.number().int().positive(), 'wiki_category'),
    guid: refersTo(z.string().regex(wikiPageGuidPattern), 'wiki_page'),
    baseVersion: classify(z.number().int().min(0), 'none'),
    note: classify(text(200), 'untrusted'),
  }),
  execute: ({ input, write }) =>
    write.plan({
      kind: 'wikiSectionAppend',
      categoryId: input.categoryId,
      guid: input.guid,
      section: input.note,
      baseVersion: input.baseVersion,
    }),
});

/**
 * Plans to add a person to a group, a write of the Pro module. The core
 * refuses it until it runs such writes, whatever the tool declares.
 */
export const exampleMemberTool = defineWriteTool({
  name: 'ct_example_member_add',
  meta: {
    capability: 'write',
    domain: 'groups',
    requiredRights: [],
    tier: 'free',
    sensitivity: 'special',
    unattended: 'never',
    routineStable: false,
    reversible: 'no',
    replayGuard: 'nonce',
  },
  description: {
    purpose: 'Adds a person to a group.',
    useWhen: 'A test needs a write of the Pro module.',
    avoidWhen: 'You want to read a group; use another tool.',
    limits: 'One person and one group per call.',
  },
  input: z.strictObject({
    groupId: classify(z.number().int().positive(), 'groupId'),
    personId: classify(z.number().int().positive(), 'personId'),
  }),
  execute: ({ input, write }) =>
    write.plan({
      kind: 'groupMemberAdd',
      groupId: input.groupId,
      personId: input.personId,
    }),
});

/** The example plugin with all its tools. */
export const examplePlugin: Plugin = {
  name: '@ecclium/example-plugin',
  version: '0.0.0',
  register(host: PluginHost): undefined {
    host.addTool(exampleProfileTool);
    host.addTool(exampleEchoTool);
    host.addTool(exampleWriteTool);
    host.addTool(exampleMemberTool);
    return undefined;
  },
};
