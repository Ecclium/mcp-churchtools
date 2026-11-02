/**
 * Private files of the server outside the audit, written once and never
 * changed (ADR 0031). The stores of day keys and snapshots build on them.
 *
 * @packageDocumentation
 */
export {
  destroyPrivateFile,
  listPrivateFolder,
  nodePrivateFileSystem,
  preparePrivateFolder,
  PrivateFileError,
  privateFileCodes,
  type PrivateFileCode,
  privateFileMode,
  type PrivateFileStats,
  type PrivateFileSystem,
  privateFolderMode,
  readPrivateFile,
  type WriteOnceOptions,
  writePrivateFileOnce,
} from './private-files.js';
