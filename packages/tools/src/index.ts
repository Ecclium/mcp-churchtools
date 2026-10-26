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
export { createCorePlugin } from './core-plugin.js';
export { eventsGetAgendaTool } from './events/agenda.js';
export { eventsGetTool } from './events/get.js';
export { eventsListTool } from './events/list.js';
export { groupsGetTool } from './groups/get.js';
export { groupsGetMembersTool } from './groups/members.js';
export { groupsSearchTool } from './groups/search.js';
export { personsGetTool } from './persons/get.js';
export { personsGetGroupsTool } from './persons/groups.js';
export { personsSearchTool } from './persons/search.js';
export { servicesGetAssignmentsTool } from './services/assignments.js';
export { servicesListTool } from './services/list.js';
export { wikiCategoriesListTool } from './wiki/categories.js';
export { wikiPageGetTool } from './wiki/page.js';
export { wikiPagesListTool } from './wiki/pages.js';
