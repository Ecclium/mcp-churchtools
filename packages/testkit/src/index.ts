/**
 * Test helpers: request handlers for a simulated ChurchTools, synthetic
 * fixtures, a mock model provider and a fake clock. Only tests use this
 * package: other packages may depend on it as a devDependency only, so it
 * is never shipped (ADR 0022).
 *
 * @packageDocumentation
 */
export {
  assertNoCanary,
  assertPlanted,
  findCanaries,
  makeCanaries,
  makeCanary,
  makeControlValue,
  type Canary,
  type CanaryFinding,
  type CanaryKind,
  type CanarySet,
} from './canary.js';
export {
  groupAtHighestLevel,
  groupMembersAtHighestLevel,
  groupsAtHighestLevel,
  type HighestLevelAnswer,
  type HighestLevelList,
  personAtHighestLevel,
  type PersonGroupFixture,
  personGroupsAtHighestLevel,
  personsAtHighestLevel,
} from './fixtures/highest-level.js';
export {
  type AppointmentDateFixture,
  type AppointmentDetailsFixture,
  appointmentAnswer,
  type AppointmentFixture,
  appointmentsAnswer,
  type BookingFixture,
  bookingsAnswer,
  calendarsAnswer,
  resourcesAnswer,
  resourceTypesAnswer,
} from './fixtures/calendars.js';
export {
  agendaAnswer,
  type AssignmentFixture,
  eventAnswer,
  eventAssignmentsAnswer,
  type EventDetailsFixture,
  type EventFixture,
  eventsAnswer,
  type ServiceFixture,
  serviceGroupsAnswer,
  servicesAnswer,
} from './fixtures/events.js';
export {
  type ChurchToolsDoubleOptions,
  createChurchToolsDouble,
  doubleOrigin,
  doubleUserAgent,
  type InterceptOptions,
  type MockedCall,
  type MockedHttpTransport,
} from './http-double/index.js';
export {
  exampleEchoTool,
  examplePlugin,
  exampleProfileTool,
  exampleWriteTool,
} from './plugins/example/index.js';
export {
  createSpecialPlugin,
  type SpecialPluginOptions,
} from './plugins/special/index.js';
export {
  createMemoryQuotaStore,
  type OpenQuotaStore,
  quotaContext,
  type QuotaMemory,
  type QuotaStoreCheck,
  quotaStoreChecks,
} from './quota/index.js';
