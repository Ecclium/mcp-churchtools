/**
 * The snapshots of core (ADR 0031): the store that keeps their sealed
 * records in a folder per UTC day of the folder of state.
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
} from './keeper.js';
