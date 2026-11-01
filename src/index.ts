// The stable public kit — everything re-exported here is contractual.
// Anything else (provider implementations, pkce, overlayClose, and all
// members prefixed with _) is internal and free to change between versions.

// Provider contract
export { StorageProvider } from './StorageProvider.js';
export type { StorageStatus, RemoteData, SaveResult } from './StorageProvider.js';
export type { AuthFailure, AuthFailureKind } from './AuthFailure.js';

// Configuration types (provider blocks + sync block)
export type { StorageConfig, GoogleDriveConfig, ConfirmDialogRequest, SyncConfig } from './config.js';

// Facade
export { StorageManager } from './StorageManager.js';
export type { ProviderName } from './StorageManager.js';

// The only concrete provider apps instantiate (demo sessions, useProvider)
export { ReadOnlyProvider } from './providers/ReadOnlyProvider.js';

// Offline-first sync layer
export { SyncEngine, UNRECONCILABLE } from './sync/SyncEngine.js';
export type { MergePolicy, SyncEngineOptions, SaveVerdict, SyncStatus } from './sync/SyncEngine.js';
export { MemoryStore, IdbStore } from './sync/LocalStore.js';
export type { LocalStore } from './sync/LocalStore.js';
