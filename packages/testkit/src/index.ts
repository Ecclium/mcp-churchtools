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
  canaryFrom,
  findCanaries,
  makeCanaries,
  makeCanary,
  makeControlValue,
  type Canary,
  type CanaryFinding,
  type CanaryKind,
  type CanarySet,
} from './canary.js';
export { coreToolCatalog } from './catalog.js';
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
  syntheticDocsIndex,
  syntheticFactFiles,
  syntheticFacts,
  syntheticRightsPage,
  syntheticThingsPage,
} from './fixtures/docs-facts.js';
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
  globalSearchAnswer,
  type SearchHitFixture,
  type WikiSearchHitFixture,
  wikiSearchAnswer,
} from './fixtures/search.js';
export {
  type ArrangementFixture,
  songAnswer,
  type SongFixture,
  songsAnswer,
} from './fixtures/songs.js';
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
export { redactedOutcome } from './redacted/index.js';
export { ahvOf, groupedAhv, ibanOf, printedIban } from './synthetic-numbers.js';
export {
  compatibilityForms,
  hiddenCharacters,
  lookalikeOf,
  lookalikes,
  searchable,
  type VariantChoice,
  variantOf,
} from './variants.js';
