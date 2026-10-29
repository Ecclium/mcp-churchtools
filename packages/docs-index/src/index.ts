/**
 * Index of facts from the ChurchTools documentation and the search over it.
 * It is built ahead of time and needs no network access at run time
 * (ADR 0027, ADR 0066).
 *
 * @packageDocumentation
 */
export {
  type AcademyPage,
  type AcademySource,
  type AcademySourcePage,
  canonicalJson,
  describeViolation,
  DocsFactsError,
  type FactFile,
  type FactFileName,
  type FactFileTexts,
  factFileLimits,
  factFiles,
  factFormats,
  type FactRule,
  type Facts,
  type FactViolation,
  maxShapeDepth,
  type OpenApiSource,
  type OperationContent,
  type OperationFact,
  type OperationParameter,
  type OperationRequestBody,
  type OperationResponse,
  operationMethods,
  parameterLocations,
  parseFactFiles,
  type PermissionsSource,
  type RightFact,
  type RightLabel,
  rightKinds,
  type Shape,
  shapeDepth,
  type ShapeProperty,
  shapeTypes,
  type Sources,
} from './facts.js';
export {
  academyHost,
  academyOrigin,
  allowedHosts,
  allowedMailDomain,
  checkedEndings,
  findForeignHosts,
  findHostsIn,
  type HostFinding,
  type HostKind,
  walkStrings,
} from './hosts.js';
export {
  hasHtmlTag,
  looksLikeHtmlPage,
  looksLikeOpenApiDocument,
} from './raw-sources.js';
export {
  buildSearchIndex,
  type SearchDocument,
  type SearchField,
  type SerializedSearchIndex,
} from './search/build.js';
export {
  matchWeights,
  maxQueryWords,
  maxSearchHits,
  minPartLength,
  minTypoLength,
  prepareSearch,
  type Searcher,
  type SearchHit,
} from './search/query.js';
export {
  maxWordLength,
  minWordLength,
  stopWords,
  words,
} from './search/words.js';
