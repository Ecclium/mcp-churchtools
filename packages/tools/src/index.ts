/**
 * Domain tools, MCP prompts and the generic API tools, one module per
 * ChurchTools area. Tools only return data; everything around a call happens
 * in the core.
 *
 * The plugin of the free core adds the tools to the catalog of the core.
 *
 * @packageDocumentation
 */
export { appointmentsGetTool } from './appointments/get.js';
export { appointmentsListTool } from './appointments/list.js';
export { whoamiTool } from './base/whoami.js';
export { bookingsListTool } from './bookings/list.js';
export { calendarsListTool } from './calendars/list.js';
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
export { resourcesListTool } from './resources/list.js';
export { servicesGetAssignmentsTool } from './services/assignments.js';
export { servicesListTool } from './services/list.js';
export { wikiCategoriesListTool } from './wiki/categories.js';
export { wikiPageGetTool } from './wiki/page.js';
export { wikiPagesListTool } from './wiki/pages.js';
