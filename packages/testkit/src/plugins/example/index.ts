/**
 * Example of a plugin as a third party would write it. It imports nothing
 * but the plugin API and zod, which a plugin brings itself. That shows the
 * plugin API alone is enough to write a plugin (ADR 0022).
 *
 * Its tools serve the tests of registry and pipeline: one reads the account
 * through the read access of a call, one returns its input in fields of
 * every class that redaction and the data envelope treat, and one writes,
 * which the pipeline refuses until the core can confirm a write.
 *
 * @packageDocumentation
 */
import {
  classify,
  defineTool,
  type Plugin,
  type PluginHost,
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

/** A write tool, to show that the pipeline refuses every write for now. */
export const exampleWriteTool = defineTool({
  name: 'ct_example_note_write',
  meta: {
    capability: 'write',
    domain: 'wiki',
    requiredRights: [{ module: 'churchwiki', right: 'edit' }],
    tier: 'free',
    sensitivity: 'none',
    unattended: 'policy',
    routineStable: false,
    reversible: 'snapshot',
    replayGuard: 'nonce',
  },
  description: {
    purpose: 'Pretends to write a note.',
    useWhen: 'A test needs a write tool.',
    avoidWhen: 'You want to write anything; this tool writes nothing.',
    limits: 'Writes nothing.',
  },
  input: z.object({ note: classify(text(200), 'none') }),
  output: z.object({ done: classify(z.boolean(), 'none') }),
  execute: () => Promise.resolve({ done: true }),
});

/** The example plugin with all three tools. */
export const examplePlugin: Plugin = {
  name: '@ecclium/example-plugin',
  version: '0.0.0',
  register(host: PluginHost): undefined {
    host.addTool(exampleProfileTool);
    host.addTool(exampleEchoTool);
    host.addTool(exampleWriteTool);
    return undefined;
  },
};
