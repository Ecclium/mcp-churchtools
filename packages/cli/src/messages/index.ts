/**
 * The catalog of German texts of the command line (ADR 0055). It only
 * makes texts and writes nothing; the output module and the start notices
 * write them.
 *
 * @packageDocumentation
 */
export {
  formatNumber,
  type Message,
  type MessageText,
  problemMessage,
  problemText,
  warningMessage,
  warningText,
} from './config.js';
export {
  auditFileMessage,
  auditFileText,
  emptyToolsetMessage,
  emptyToolsetText,
  quotaFolderMessage,
  quotaFolderText,
  refusalMessage,
  refusalText,
  type StartNoticeCode,
  startMessage,
  startText,
  toolsetsMessage,
  toolsetsText,
} from './start.js';
