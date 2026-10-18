/**
 * Domain tools, MCP prompts and the generic API tools, one module per
 * ChurchTools area. Tools only return data; everything around a call happens
 * in the core.
 *
 * The plugin of the free core adds the tools to the catalog of the core.
 *
 * @packageDocumentation
 */
export { whoamiTool } from './base/whoami.js';
export { corePlugin } from './core-plugin.js';
