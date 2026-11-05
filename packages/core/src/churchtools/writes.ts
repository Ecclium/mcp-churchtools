/**
 * The writes of the ChurchTools client in one group (ADR 0072): those of
 * the wiki and those of calendars and resources, each with the reads a
 * plan needs. The client gives them under `writes`, so that one rule of
 * the architecture keeps every caller but the write guard away from them
 * (ADR 0029).
 *
 * @packageDocumentation
 */
import type { CalendarWrites } from './calendar-writes.js';
import type { WikiWrites } from './wiki-writes.js';

/**
 * Every write of the client and the reads a plan needs. Only the write
 * guard of the core is to call them; tools reach ChurchTools through the
 * pipeline and never see the client (ADR 0024).
 */
export type ChurchToolsWrites = WikiWrites & CalendarWrites;
