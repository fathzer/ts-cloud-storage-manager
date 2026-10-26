import type { MergePolicy, SyncEngineOptions } from './sync/SyncEngine.js';

/**
 * Application wiring: a provider is offered only when its config block is
 * present. fileName applies to every provider (same data file everywhere).
 * A present `sync` block enables the offline-first SyncEngine — the manager
 * then owns its whole lifecycle.
 */
export interface StorageConfig {
  /** Name of the data file stored in the provider's app area. */
  fileName?: string;
  dropbox?: { appKey: string };
  oneDrive?: { clientId: string };
  google?: GoogleDriveConfig;
  /** Offline-first sync: present = enabled, through StorageManager. */
  sync?: SyncConfig;
}

export interface GoogleDriveConfig {
  clientId: string;
  /** appProperties tag identifying the data file on Drive. */
  appTag?: string;
  /**
   * Optional app-provided renderer for the confirmation dialogs the Google
   * provider needs mid-flow (reconnection / missing scopes). Receives a kind
   * plus English fallback strings; the app may map `kind` to its own
   * localized wording instead. When unset, built-in English dialogs are used.
   */
  confirmDialog?: (request: ConfirmDialogRequest) => Promise<boolean>;
}

/** A confirmation a provider needs from the user mid-flow. */
export interface ConfirmDialogRequest {
  kind: 'reconnect' | 'missingScopes';
  title: string;
  bodyHtml: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** The `sync` block of {@link StorageConfig}: policy + engine options. */
export interface SyncConfig extends SyncEngineOptions {
  /** Merge policy — defaults to always UNRECONCILABLE: every divergence
   *  parks for user resolution (the conservative whole-file behavior). */
  policy?: MergePolicy;
}
