/**
 * The plugin of the free core. It adds the tools and prompts of the core
 * through the same host as any other plugin and, like a plugin of a third
 * party, imports only the plugin API and zod (ADR 0022). The composition
 * root hands it to the catalog as the core, so its tools carry the origin
 * `core`, and no other plugin may take its name.
 *
 * @packageDocumentation
 */
import type { Plugin, PluginHost } from '@ecclium/mcp-churchtools-plugin-api';

import { appointmentsGetTool } from './appointments/get.js';
import { appointmentsListTool } from './appointments/list.js';
import { whoamiTool } from './base/whoami.js';
import { bookingsListTool } from './bookings/list.js';
import { calendarsListTool } from './calendars/list.js';
import { eventsGetAgendaTool } from './events/agenda.js';
import { eventsGetTool } from './events/get.js';
import { eventsListTool } from './events/list.js';
import { groupsGetTool } from './groups/get.js';
import { groupsGetMembersTool } from './groups/members.js';
import { groupsSearchTool } from './groups/search.js';
import { personsGetTool } from './persons/get.js';
import { personsGetGroupsTool } from './persons/groups.js';
import { personsSearchTool } from './persons/search.js';
import { rotaWeekendPrompt } from './prompts/rota-weekend.js';
import { wikiDraftPrompt } from './prompts/wiki-draft.js';
import { resourcesListTool } from './resources/list.js';
import { searchTool } from './search/global.js';
import { servicesGetAssignmentsTool } from './services/assignments.js';
import { servicesListTool } from './services/list.js';
import { songsGetTool } from './songs/get.js';
import { songsSearchTool } from './songs/search.js';
import { wikiCategoriesListTool } from './wiki/categories.js';
import { wikiPageGetTool } from './wiki/page.js';
import { wikiPagesListTool } from './wiki/pages.js';
import { wikiSearchTool } from './wiki/search.js';

/**
 * Builds the plugin of the free core, under the name of the package of the
 * server, which the catalog reserves for it. It adds every tool and both
 * prompts of the core. Which of them the catalog offers decides the
 * composition root with the toolsets of the operator (`ECCLIUM_TOOLSETS`,
 * ADR 0062): without any, a server on a productive tenant offers only
 * `ct_whoami` and no prompt, because each prompt needs its tools (ADR
 * 0065).
 *
 * @returns The plugin, frozen.
 * @example
 * ```ts
 * const catalog = createToolCatalog({
 *   core: createCorePlugin(),
 *   plugins: [],
 *   readOnly: true,
 * });
 * catalog.get('ct_whoami')?.origin; // 'core'
 * ```
 */
export function createCorePlugin(): Plugin {
  return Object.freeze({
    name: '@ecclium/mcp-churchtools',
    version: '0.0.0',
    register(host: PluginHost): undefined {
      host.addTool(whoamiTool);
      host.addTool(personsSearchTool);
      host.addTool(personsGetTool);
      host.addTool(personsGetGroupsTool);
      host.addTool(groupsSearchTool);
      host.addTool(groupsGetTool);
      host.addTool(groupsGetMembersTool);
      host.addTool(searchTool);
      host.addTool(wikiCategoriesListTool);
      host.addTool(wikiPagesListTool);
      host.addTool(wikiPageGetTool);
      host.addTool(wikiSearchTool);
      host.addTool(eventsListTool);
      host.addTool(eventsGetTool);
      host.addTool(eventsGetAgendaTool);
      host.addTool(servicesListTool);
      host.addTool(servicesGetAssignmentsTool);
      host.addTool(calendarsListTool);
      host.addTool(appointmentsListTool);
      host.addTool(appointmentsGetTool);
      host.addTool(resourcesListTool);
      host.addTool(bookingsListTool);
      host.addTool(songsSearchTool);
      host.addTool(songsGetTool);
      host.addPrompt(rotaWeekendPrompt);
      host.addPrompt(wikiDraftPrompt);
      return undefined;
    },
  });
}
