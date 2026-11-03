/**
 * The snapshots of core (ADR 0031): the store that keeps their sealed
 * records in a folder per UTC day of the folder of state, and the keeper
 * that seals and opens them with the day keys.
 *
 * @packageDocumentation
 */
export {
  createFileSnapshotStore,
  type FileSnapshotStoreOptions,
  prepareSnapshotFolder,
  snapshotFolderName,
} from './file-store.js';
export {
  createSnapshotKeeper,
  type LoadedSnapshot,
  type SnapshotKeeper,
  type SnapshotPurge,
} from './keeper.js';
