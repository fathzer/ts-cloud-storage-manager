import { bindOverlayClose } from '../overlayClose.js';
import { StorageProvider } from '../StorageProvider.js';
import type { StorageStatus, RemoteData, SaveResult } from '../StorageProvider.js';
import type { ConfirmDialogRequest } from '../config.js';
import type { AuthFailure, AuthFailureKind } from '../AuthFailure.js';

export interface GoogleDriveOptions {
  /** Name of the data file (default 'data.json'). */
  fileName?: string;
  /** appProperties tag identifying the data file (default 'appdata'). */
  appTag?: string;
  /** App-provided renderer for mid-flow confirmations (reconnection,
   *  missing scopes); falls back to the built-in English dialogs. */
  confirmDialog?: (request: ConfirmDialogRequest) => Promise<boolean>;
}

// Minimal type declarations for the Google Identity Services (GIS) client.
// Loaded dynamically from https://accounts.google.com/gsi/client.
interface GisTokenResponse {
  access_token?: string;
  error?: unknown;
}

interface GisErrorCallbackPayload {
  type?: string;
  message?: string;
}

interface GisTokenClient {
  callback: (resp: GisTokenResponse) => void | Promise<void>;
  error_callback?: (error: GisErrorCallbackPayload) => void;
  requestAccessToken: (request: { prompt: string; login_hint?: string }) => void;
}

interface GisOauth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (error: GisErrorCallbackPayload) => void;
  }) => GisTokenClient;
  hasGrantedAllScopes: (resp: GisTokenResponse, ...scopes: string[]) => boolean;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GisOauth2 } };
  }
  const google: { accounts: { oauth2: GisOauth2 } } | undefined;
}

interface DriveFile {
  id?: string;
  name?: string;
  version?: string;
  appProperties?: Record<string, string>;
}

type ApiCall = () => Promise<Response>;

export class GoogleDriveProvider extends StorageProvider {
  static readonly TOKEN_EXPIRATION_MS = 3600 * 1000; // 1 hour in milliseconds
  static readonly DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  static readonly EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

  clientId: string;
  fileName: string;
  /** appProperties tag identifying the data file (users may rename it). */
  appTag: string;
  accessToken: string | null;
  tokenExpiration: string | number | null;
  userEmail: string | null;
  tokenClient: GisTokenClient | null;
  fileId: string | null;
  _fileNameCache: { fileId: string; name: string } | null;
  _lastError: GisErrorCallbackPayload | null;
  /** Settled attempt hook: error_callback (blocked/closed popup) never
   *  reaches `callback`, so authenticate() resolves through this instead. */
  _pendingAuthError: ((error: GisErrorCallbackPayload) => void) | null;
  _authFailure: AuthFailure | null;

  confirmDialog?: (request: ConfirmDialogRequest) => Promise<boolean>;

  /**
   * @param clientId the Google OAuth client id.
   * @param options file name, appProperties tag and the injectable
   *        confirmDialog hook.
   */
  constructor(clientId: string, options: GoogleDriveOptions = {}) {
    super();
    this.clientId = clientId;
    this.fileName = options.fileName ?? 'data.json';
    this.appTag = options.appTag ?? 'appdata';
    this.confirmDialog = options.confirmDialog;
    this.accessToken = localStorage.getItem('gdrive_token') || null;
    this.tokenExpiration = localStorage.getItem('gdrive_token_expiration') || null;
    this.userEmail = localStorage.getItem('gdrive_user_email') || null;
    this.tokenClient = null;
    this.fileId = null;
    this._fileNameCache = null;
    this._lastError = null;
    this._pendingAuthError = null;
    this._authFailure = null;
  }

  override getAuthFailure(): AuthFailure | null {
    return this._authFailure;
  }

  override async init(): Promise<boolean> {
    if (!this.clientId) return !!this.accessToken;
    await this.initGis();
    return !!this.accessToken;
  }

  initGis(): Promise<boolean> {
    return new Promise((resolve) => {
      if (window.google?.accounts?.oauth2) {
        this._setupTokenClient(resolve);
      } else {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => this._setupTokenClient(resolve);
        document.head.appendChild(script);
      }
    });
  }

  _setupTokenClient(resolve: (value: boolean) => void): void {
    this.tokenClient = google!.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: `${GoogleDriveProvider.DRIVE_SCOPE} ${GoogleDriveProvider.EMAIL_SCOPE}`,
      callback: () => {},
      error_callback: (error: GisErrorCallbackPayload) => {
        console.error('Google token client error:', error);
        this._lastError = error;
        this._pendingAuthError?.(error);
      }
    });
    resolve(true);
  }

  override async authenticate(): Promise<boolean> {
    if (!this.tokenClient) await this.initGis();
    return new Promise((resolve) => {
      this.tokenClient!.callback = async (resp: GisTokenResponse) => {
        this._pendingAuthError = null;
        if (resp.error) {
          this._authFailure = resp.error === 'access_denied'
            ? { kind: 'accessDenied' }
            : { kind: 'error', detail: typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error) };
          return resolve(false);
        }

        // Google's granular consent lets the user uncheck the Drive access
        // (it may even be unchecked by default). A token without the scope is
        // useless, so inform the user and restart the authentication.
        if (!this._hasGrantedRequiredScopes(resp)) {
          const retry = await this._showMissingScopesDialog();
          if (!retry) this._authFailure = { kind: 'accessDenied' };
          return resolve(retry ? await this.authenticate() : false);
        }

        this._authFailure = null;

        this._saveToken(resp.access_token!);
        // The account may have changed, the cached file id is no longer valid
        this.fileId = null;
        this._fileNameCache = null;

        // Fetch user email from userinfo endpoint
        await this._fetchUserEmail();

        resolve(true);
      };
      // A blocked or user-closed popup triggers error_callback instead of
      // callback — without this hook the promise would hang forever.
      this._pendingAuthError = (error) => {
        const kinds: Record<string, AuthFailureKind> = {
          popup_failed_to_open: 'popupBlocked',
          popup_closed: 'popupClosed'
        };
        const kind = kinds[error.type ?? ''];
        this._authFailure = kind ? { kind } : { kind: 'error', detail: error.type };
        resolve(false);
      };
      this._authFailure = null;
      this.tokenClient!.requestAccessToken({ prompt: 'consent' });
    });
  }

  _hasGrantedRequiredScopes(resp: GisTokenResponse): boolean {
    return google!.accounts.oauth2.hasGrantedAllScopes(
      resp, GoogleDriveProvider.DRIVE_SCOPE, GoogleDriveProvider.EMAIL_SCOPE
    );
  }

  async _fetchUserEmail(): Promise<void> {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      if (response.ok) {
        const userInfo = await response.json() as { email?: string };
        if (userInfo.email) {
          this.userEmail = userInfo.email;
          localStorage.setItem('gdrive_user_email', this.userEmail);
        }
      }
    } catch (error) {
      console.error('Failed to fetch user email:', error);
    }
  }

  override disconnect(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiration = null;
    this.userEmail = null;
    this._fileNameCache = null;
    localStorage.removeItem('gdrive_token');
    localStorage.removeItem('gdrive_token_expiration');
    localStorage.removeItem('gdrive_user_email');
    return Promise.resolve();
  }

  _saveToken(accessToken: string): void {
    this.accessToken = accessToken;
    localStorage.setItem('gdrive_token', this.accessToken);
    this.tokenExpiration = Date.now() + GoogleDriveProvider.TOKEN_EXPIRATION_MS;
    localStorage.setItem('gdrive_token_expiration', String(this.tokenExpiration));
  }

  _isTokenExpired(): boolean {
    if (!this.tokenExpiration) return true;
    return Date.now() >= Number.parseInt(String(this.tokenExpiration), 10);
  }

  async _silentRefresh(): Promise<boolean> {
    if (!this.tokenClient) await this.initGis();

    this._lastError = null;

    return new Promise((resolve) => {
      this.tokenClient!.callback = (resp: GisTokenResponse) => {
        if (resp.error) {
          console.error('Silent token refresh failed:', resp.error);
          resolve(false);
        } else if (!this._hasGrantedRequiredScopes(resp)) {
          console.error('Silent token refresh returned a token without the required scopes');
          resolve(false);
        } else {
          this._saveToken(resp.access_token!);
          resolve(true);
        }
      };

      const tokenRequest: { prompt: string; login_hint?: string } = { prompt: '' };
      if (this.userEmail) {
        tokenRequest.login_hint = this.userEmail;
      }

      this.tokenClient!.requestAccessToken(tokenRequest);

      // Check for error_callback after a short delay to detect popup blocking
      setTimeout(() => {
        if (this._lastError) {
          console.error('Popup blocked detected via error_callback:', this._lastError);
          resolve(false);
        }
      }, 100);
    });
  }

  _showReconnectionDialog(): Promise<boolean> {
    return this._confirm({
      kind: 'reconnect',
      title: 'Reconnection required',
      bodyHtml: `
        <h3 class="help-section-title">Access token expired</h3>
        <p><strong>Why this window?</strong></p>
        <p>Your Google Drive access token has expired. For security reasons, Google does not allow automatic reconnection without explicit user action unless your login data transits through our servers — which would break our promise "None of your data is sent to us".</p>
        <p><strong>What you need to do:</strong></p>
        <p>Click the "Reconnect" button below to grant access to your Google Drive again. A pop-up window will open and ask you to confirm the authorization.</p>
        <p><strong>Important:</strong> make sure your browser allows pop-ups for this site, otherwise the Google sign-in window will not open. If you see a blocked pop-up icon in the address bar, click it to temporarily allow pop-ups.</p>
      `,
      confirmLabel: 'Reconnect',
      cancelLabel: 'Cancel'
    });
  }

  _showMissingScopesDialog(): Promise<boolean> {
    return this._confirm({
      kind: 'missingScopes',
      title: 'Missing authorization',
      bodyHtml: `
        <h3 class="help-section-title">Google permissions not granted</h3>
        <p><strong>Why this window?</strong></p>
        <p>You are signed in, but you did not grant all the permissions this application needs: access to your Google Drive files (to read and save your data) and access to your email address (to identify your account).</p>
        <p><strong>What you need to do:</strong></p>
        <p>Click "Retry" to display the Google consent screen again, then check every requested option.</p>
      `,
      confirmLabel: 'Retry',
      cancelLabel: 'Cancel'
    });
  }

  /** Routes a mid-flow confirmation to the app-provided renderer when one
   *  was injected, else to the built-in English modal. */
  _confirm(request: ConfirmDialogRequest): Promise<boolean> {
    return this.confirmDialog
      ? this.confirmDialog(request)
      : this._defaultConfirmDialog(request);
  }

  /** Built-in modal rendering of a ConfirmDialogRequest (English). */
  _defaultConfirmDialog(request: ConfirmDialogRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.innerHTML = `
        <div class="modal-overlay">
          <div class="modal-content help-modal-content">
            <h2 class="help-modal-header"></h2>
            <div class="help-modal-body">
              <section class="help-section"></section>
            </div>
            <div class="modal-actions help-modal-footer">
              <button type="button" id="btn-cancel" class="btn-secondary"></button>
              <button type="button" id="btn-confirm" class="btn-primary"></button>
            </div>
          </div>
        </div>
      `;
      dialog.querySelector<HTMLElement>('.help-modal-header')!.textContent = request.title;
      dialog.querySelector<HTMLElement>('.help-section')!.innerHTML = request.bodyHtml;
      const confirmBtn = dialog.querySelector<HTMLButtonElement>('#btn-confirm')!;
      const cancelBtn = dialog.querySelector<HTMLButtonElement>('#btn-cancel')!;
      confirmBtn.textContent = request.confirmLabel;
      cancelBtn.textContent = request.cancelLabel;
      const overlay = dialog.querySelector<HTMLElement>('.modal-overlay');

      document.body.appendChild(dialog);

      const close = (confirmed = false) => {
        dialog.remove();
        resolve(confirmed);
      };

      confirmBtn.addEventListener('click', () => close(true));
      cancelBtn.addEventListener('click', () => close(false));
      if (overlay) bindOverlayClose(overlay, () => close(false));
    });
  }

  async _executeWithAuthRetry(apiCall: ApiCall): Promise<Response> {
    await this._handleTokenExpiration();
    const result = await apiCall();
    return await this._handleAuthError(result, apiCall);
  }

  async _handleTokenExpiration(): Promise<void> {
    if (this._isTokenExpired()) {
      const refreshed = await this._silentRefresh();
      if (!refreshed) {
        await this._forceReconnection();
      }
    }
  }

  async _forceReconnection(): Promise<void> {
    const userConfirmed = await this._showReconnectionDialog();
    if (userConfirmed) {
      const success = await this.authenticate();
      if (!success) {
        throw new Error('Authentication failed');
      }
    } else {
      throw new Error('User cancelled reconnection');
    }
  }

  async _handleAuthError(result: Response, apiCall: ApiCall): Promise<Response> {
    if (result instanceof Response && result.status === 401) {
      return await this._retryAfterAuthError(apiCall);
    }
    return result;
  }

  async _retryAfterAuthError(apiCall: ApiCall): Promise<Response> {
    const refreshed = await this._silentRefresh();
    if (refreshed) {
      return await apiCall();
    }
    const userConfirmed = await this._showReconnectionDialog();
    if (userConfirmed) {
      const success = await this.authenticate();
      if (success) {
        return await apiCall();
      }
    }
    throw new Error('Authentication failed after reconnection');
  }

  async _findFileId(): Promise<string | null> {
    if (this.fileId) return this.fileId;

    // The drive.file scope only lists files created by this app, and it rejects
    // queries on appProperties. So list every app-created file and filter
    // client-side: the data file is identified by its private appProperties tag
    // (users may rename or move it), falling back to the file name for files
    // created before tagging was introduced.
    const res = await this._executeWithAuthRetry(async () => {
      const params = new URLSearchParams({
        q: 'trashed = false',
        orderBy: 'modifiedTime desc',
        pageSize: '100',
        fields: 'files(id,name,appProperties)'
      });
      return await fetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
    });

    if (!res.ok) {
      throw new Error(`Failed to search data file on Google Drive: HTTP ${res.status}`);
    }

    const data = await res.json() as { files?: DriveFile[] };
    const files = data.files ?? [];
    const file = files.find(f => f.appProperties?.[this.appTag] === 'data')
      ?? files.find(f => f.name === this.fileName);
    if (file) {
      this.fileId = file.id!;
      return this.fileId;
    }
    return null;
  }

  /** The Drive revision token (`version`) of the data file — metadata only.
   *  Drive v3 exposes no file-level etag (that was a v2 field). */
  async _fetchFileVersion(fileId: string): Promise<string | null> {
    const res = await this._executeWithAuthRetry(async () => {
      return await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=version`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
    });
    if (!res.ok) return null;
    const meta = await res.json() as DriveFile;
    return meta.version ?? null;
  }

  override async load(): Promise<RemoteData | null> {
    if (!this.accessToken) return null;
    const fileId = await this._findFileId();
    if (!fileId) return null;

    const res = await this._executeWithAuthRetry(async () => {
      return await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
    });

    if (!res.ok) {
      throw new Error(`Failed to load data file from Google Drive: HTTP ${res.status}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error('Data file content is not valid JSON');
    }
    return { data, rev: await this._fetchFileVersion(fileId) };
  }

  override async save(data: unknown, baseRev: string | null): Promise<SaveResult> {
    if (!this.accessToken) throw new Error('No Google Drive session');
    const fileId = await this._findFileId();
    const content = JSON.stringify(data, null, 2);

    if (!fileId) {
      return await this._createNewFile(content);
    }
    // Drive v3 does not reliably honor If-Match on media uploads (that was a
    // v2 feature), so the guard is check-then-write: a small race window
    // remains, documented in the contract.
    if (baseRev !== null) {
      const remoteRev = await this._fetchFileVersion(fileId);
      if (remoteRev === null || remoteRev !== baseRev) return { status: 'conflict' };
    }
    return await this._updateExistingFile(fileId, content);
  }

  async _updateExistingFile(fileId: string, content: string): Promise<SaveResult> {
    const res = await this._executeWithAuthRetry(async () => {
      return await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,version`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: content
        }
      );
    });

    if (!res.ok) throw new Error(`Google Drive upload failed: HTTP ${res.status}`);
    const meta = await res.json() as DriveFile;
    return { status: 'saved', rev: meta.version ?? null };
  }

  async _createNewFile(content: string): Promise<SaveResult> {
    const metadata = {
      name: this.fileName,
      mimeType: 'application/json',
      appProperties: { [this.appTag]: 'data' }
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));

    const res = await this._executeWithAuthRetry(async () => {
      return await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.accessToken}` },
          body: form
        }
      );
    });

    if (!res.ok) throw new Error(`Google Drive file creation failed: HTTP ${res.status}`);
    const createdFile = await res.json() as DriveFile;
    if (createdFile.id) {
      this.fileId = createdFile.id;
    }
    return { status: 'saved', rev: createdFile.version ?? null };
  }

  override async getRemoteRevision(): Promise<string | null> {
    if (!this.accessToken) return null;
    const fileId = await this._findFileId();
    if (!fileId) return null;
    return await this._fetchFileVersion(fileId);
  }

  override getStatus(): Promise<StorageStatus> {
    return Promise.resolve({ isConnected: !!this.accessToken, providerName: 'Google Drive', userEmail: this.userEmail ?? undefined });
  }

  override async getDataLocation(): Promise<string | null> {
    if (!this.accessToken) return null;
    const account = this.userEmail ? ` (${this.userEmail})` : '';
    return `Google Drive${account}: /${await this._resolveFileName()}`;
  }

  /**
   * Best-effort resolution of the data file's current name (the user may have
   * renamed it on Drive). Never triggers an authentication flow: any failure
   * falls back to the default file name.
   */
  async _resolveFileName(): Promise<string> {
    const fileId = this.fileId;
    if (!fileId) return this.fileName;
    if (this._fileNameCache?.fileId === fileId) return this._fileNameCache.name;
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (res.ok) {
        const meta = await res.json() as DriveFile;
        if (meta.name) {
          this._fileNameCache = { fileId, name: meta.name };
          return meta.name;
        }
      }
    } catch (error) {
      console.error('Failed to resolve data file name:', error);
    }
    return this.fileName;
  }
}
