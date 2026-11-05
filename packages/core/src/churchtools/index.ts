/**
 * Raw ChurchTools client. Only the core modules listed in the architecture
 * rules import it. Tools and plugins reach ChurchTools through the tool
 * pipeline, and the entry point of core never passes the client on
 * (ADR 0024, ADR 0057).
 *
 * @packageDocumentation
 */
export {
  type ChurchToolsClient,
  type ChurchToolsClientOptions,
  createChurchToolsClient,
} from './client.js';
export type {
  AppointmentChange,
  AppointmentPart,
  AppointmentState,
  BookingState,
  CalendarDayState,
  CalendarFacts,
  CalendarWrites,
  DatedFields,
  ResourceDayState,
  StoredAppointment,
  StoredBooking,
} from './calendar-writes.js';
export type {
  CreatedWikiPage,
  WikiPageState,
  WikiWrites,
} from './wiki-writes.js';
export type { ChurchToolsWrites } from './writes.js';
export type {
  ObjectValue,
  OperationAnswer,
  OperationRequest,
} from './operation.js';
export { tooLargeAnswer } from './operation.js';
export { listReadableOperations } from './operation-list.js';
