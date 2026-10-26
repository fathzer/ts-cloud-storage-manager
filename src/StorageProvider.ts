import type { AuthFailure } from './AuthFailure.js';

export interface StorageStatus {
  isConnected: boolean;
  providerName: string;
  userEmail?: string;
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
  /**
   * Restores a persisted session (tokens in localStorage) without user
   * interaction.
   * @returns true when a usable session was restored.
   */
  init(): Promise<boolean> { return Promise.resolve(false); }

  /**
   * Interactive login. Redirect-flow providers navigate the whole page away
   * and never resolve — the flow concludes via {@link resumeAuth} on the
   * way back.
   * @returns true when connected (popup-flow providers only).
   */
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
   * @param _url the URL the provider sent the browser back to.
   * @returns 'none' when the URL carries no OAuth parameter for this
   *          provider, otherwise the auth verdict.
   */
  resumeAuth(_url: URL): Promise<boolean | 'none'> { return Promise.resolve('none'); }

  /**
   * Ends the session and clears stored credentials (tokens, file id).
   * @returns resolves once credentials are cleared.
   */
  disconnect(): Promise<void> { return Promise.resolve(); }

  /**
   * Downloads the data file.
   * @returns the file content and its revision token, or null when the
   *          remote file does not exist; the rev lets callers detect later
   *          remote changes.
   */
  abstract load(): Promise<RemoteData | null>;

  /**
   * Optimistic-concurrency save.
   * @param data the full data-file payload to write.
   * @param baseRev the rev the data was built from — null means an
   *        unconditional write (very first save or unknown revision).
   * @returns 'saved' with the new remote revision, or 'conflict' when the
   *          remote file changed since baseRev and the write was refused.
   */
  abstract save(data: unknown, baseRev: string | null): Promise<SaveResult>;

  /**
   * Reads the current remote revision without downloading the file content
   * (metadata only). Auth errors are thrown so callers can stop polling on
   * a dead session.
   * @returns the current rev, or null when the file is absent or its
   *          revision indeterminable.
   */
  getRemoteRevision(): Promise<string | null> { return Promise.resolve(null); }

  /**
   * @returns the connection state and provider display name for the UI.
   */
  abstract getStatus(): Promise<StorageStatus>;

  /**
   * @returns a human-readable description of where the data is stored
   *          (account, file path...), or null when it is unknown.
   */
  getDataLocation(): Promise<string | null> { return Promise.resolve(null); }

  /**
   * @returns true when this provider silently drops saves (read-only data):
   *          the UI warns the user that changes live in memory only.
   */
  isReadOnly(): boolean { return false; }

  /**
   * @returns why the last interactive authenticate() attempt failed,
   *          classified for the UI (see AuthFailure.ts); null when no
   *          attempt failed.
   */
  getAuthFailure(): AuthFailure | null { return null; }
}
