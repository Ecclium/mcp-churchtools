/**
 * Private files of the server outside the audit (ADR 0031). Most are
 * written once and never changed; the stores of day keys and snapshots
 * build on them. The runner also replaces a draft whole and adds a notice
 * as one line at the end of a file (ADR 0033).
 *
 * @packageDocumentation
 */
export {
  type AppendLineOptions,
  appendPrivateLine,
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
  removePrivateFolder,
  replacePrivateFile,
  type ReplaceOptions,
  type WriteOnceOptions,
  writePrivateFileOnce,
} from './private-files.js';
