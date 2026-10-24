/**
 * A plugin with one tool of sensitivity special, for the tests of the
 * audit file over stdio (ADR 0028): its result goes out only with its line
 * in the audit file. Like the example plugin, it imports nothing but the
 * plugin API and zod.
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

/** Options of {@link createSpecialPlugin}. */
export interface SpecialPluginOptions {
  /** The text the tool returns, such as a canary. */
  readonly text: string;
  /**
   * Runs in each call before the tool returns, such as to delete the audit
   * file of the test.
   */
  readonly during?: () => void;
}

/**
 * Creates the plugin with the tool `ct_test_special`, which returns the
 * text and runs `during` first.
 *
 * @param options - The text and what runs in each call.
 * @returns The plugin, named `test-special`.
 * @example
 * ```ts
 * const plugin = createSpecialPlugin({ text: canary.value });
 * ```
 */
export function createSpecialPlugin(options: SpecialPluginOptions): Plugin {
  const tool = defineTool({
    name: 'ct_test_special',
    meta: {
      capability: 'read',
      domain: 'persons',
      requiredRights: [],
      tier: 'free',
      sensitivity: 'special',
      unattended: 'never',
      routineStable: false,
    },
    description: {
      purpose: 'Returns a fixed text as a tool with special personal data.',
      useWhen: 'A test needs a tool whose result needs its audit line.',
      avoidWhen: 'You need anything else; this tool exists for tests.',
      limits: 'Returns one text.',
    },
    input: z.object({}),
    output: z.object({ text: classify(z.string().max(200), 'none') }),
    execute: () => {
      options.during?.();
      return Promise.resolve({ text: options.text });
    },
  });
  return {
    name: 'test-special',
    version: '1.0.0',
    register(host: PluginHost): undefined {
      host.addTool(tool);
      return undefined;
    },
  };
}
