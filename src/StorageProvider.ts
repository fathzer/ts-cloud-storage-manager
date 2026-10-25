import type { AuthFailure } from './AuthFailure.js';

export interface StorageStatus {
  isConnected: boolean;
  providerName: string;
  userEmail?: string;
}

export interface StorageConfig {
  googleClientId?: string;
  dropboxAppKey?: string;
  oneDriveClientId?: string;
  /** Name of the data file stored in the provider's app area. */
  fileName?: string;
  /** Google Drive appProperties tag identifying the data file. */
  driveAppTag?: string;
}

/** The data file as read from the cloud, together with the provider revision
 *  token identifying this exact remote version (Dropbox `rev`, OneDrive
 *  `eTag`, Drive `version`). */
export interface RemoteData {
  data: unknown;
  /** Opaque revision token, null when the provider cannot supply one. */
  rev: string | null;
}

/** Verdict of a revision-aware save. 'saved' carries the new remote revision
 *  (to become the next baseRev); 'conflict' means the remote file changed
 *  since baseRev and the write was refused. */
export type SaveResult =
  | { status: 'saved'; rev: string | null }
  | { status: 'conflict' };

/**
 * Abstract base class for storage providers.
 * Subclasses must implement authentication, data load/save and status retrieval.
 */
export abstract class StorageProvider {
  init(): Promise<boolean> { return Promise.resolve(false); }
  abstract authenticate(): Promise<boolean>;

  /**
   * Query-string parameters this provider produces on the OAuth return URL
   * (redirect flows only — e.g. ['code','state','error']). They are stripped
   * by the URL cleanup once consumed. Providers with a JS-callback flow
   * (Google GIS popup) keep the empty default.
   */
  readonly authResponseParams: string[] = [];

  /**
   * Redirect-flow providers: consumes the OAuth return parameters present in
   * the URL after the provider sent the browser back (exchanges the code,
   * checks the anti-CSRF state...). Returns 'none' when the URL carries
   * nothing this provider recognizes, true/false for the auth verdict.
   * Popup-flow providers keep the default no-op.
   */
  resumeAuth(_url: URL): Promise<boolean | 'none'> { return Promise.resolve('none'); }

  disconnect(): Promise<void> { return Promise.resolve(); }

  /**
   * Downloads the data file. Returns null when the remote file does not
   * exist; the rev lets callers detect later remote changes.
   */
  abstract load(): Promise<RemoteData | null>;

  /**
   * Optimistic-concurrency save. baseRev is the rev the data was built from
   * (null = unconditional write, used for the very first save or when the
   * revision is unknown). Returns 'conflict' instead of overwriting a remote
   * file that changed since baseRev.
   */
  abstract save(data: unknown, baseRev: string | null): Promise<SaveResult>;

  /**
   * Reads the current remote revision without downloading the file content
   * (metadata only). null = file absent or revision indeterminable. Auth
   * errors are thrown so callers can stop polling on a dead session.
   */
  getRemoteRevision(): Promise<string | null> { return Promise.resolve(null); }

  abstract getStatus(): Promise<StorageStatus>;

  /**
   * Returns a human-readable description of where the data is stored
   * (account, file path...), or null when it is unknown.
   */
  getDataLocation(): Promise<string | null> { return Promise.resolve(null); }

  /**
   * Whether this provider silently drops saves (read-only data): the UI warns
   * the user that changes live in memory only.
   */
  isReadOnly(): boolean { return false; }

  /**
   * Why the last interactive authenticate() attempt failed, classified for
   * the UI (see AuthFailure.ts). Null when no attempt failed.
   */
  getAuthFailure(): AuthFailure | null { return null; }
}
