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
export type { OperationAnswer, OperationRequest } from './operation.js';
