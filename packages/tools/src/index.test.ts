import {
  createToolCatalog,
  RegistryRefusal,
} from '@ecclium/mcp-churchtools-core';
import { examplePlugin } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { maxListedIds, maxListedRights } from './base/whoami.js';
import { corePlugin, whoamiTool } from './index.js';

// The entry hands out the plugin of the free core. The registry of the core
// takes it as the core and keeps ct_whoami with its metadata, a shape whose
// every leaf has a data class, and the input schema the mount advertises.

const catalog = createToolCatalog({
  core: corePlugin,
  plugins: [],
  readOnly: true,
});

describe('@ecclium/mcp-churchtools-tools', () => {
  it('hands out the plugin of the core with ct_whoami', () => {
    expect(
      catalog.list().map((tool) => [tool.name, tool.plugin, tool.origin]),
    ).toEqual([['ct_whoami', '@ecclium/mcp-churchtools', 'core']]);
  });

  it('carries the name the catalog reserves for the core', () => {
    let refusal: unknown;
    try {
      createToolCatalog({
        core: examplePlugin,
        plugins: [corePlugin],
        readOnly: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RegistryRefusal);
    expect((refusal as RegistryRefusal).reason).toBe('plugin_reserved');
  });
});

describe('ct_whoami in the catalog', () => {
  const tool = catalog.get('ct_whoami');

  it('reads only, never unattended, and needs no right', () => {
    expect(tool?.meta).toEqual({
      capability: 'read',
      domain: 'base',
      requiredRights: [],
      tier: 'free',
      sensitivity: 'personal',
      unattended: 'never',
      routineStable: false,
    });
  });

  it('gives every leaf of its output a data class', () => {
    expect(tool?.shape.unclassified).toBe(0);
    expect(tool?.shape.minimumSensitivity).toBe('personal');
  });

  it('advertises an input without properties', () => {
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('describes itself in four sections of one line each, naming no tool', () => {
    const sections = Object.entries(whoamiTool.description);
    expect(sections.map(([key]) => key)).toEqual([
      'purpose',
      'useWhen',
      'avoidWhen',
      'limits',
    ]);
    for (const [key, text] of sections) {
      expect(text, key).not.toMatch(/[\n\r]/);
      expect(text, key).not.toContain('ct_');
    }
  });

  it('names its limits with the numbers it applies', () => {
    const { limits } = whoamiTool.description;
    expect(limits).toContain(`the ${String(maxListedIds)} lowest IDs`);
    expect(limits).toContain(`more than ${String(maxListedRights)} set rights`);
    expect(limits).toContain('through a group may be missing');
    expect(limits).toContain('revoked right can still show');
  });
});
