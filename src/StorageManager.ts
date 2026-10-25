import { GoogleDriveProvider } from './providers/GoogleDriveProvider.js';
import { DropboxProvider } from './providers/DropboxProvider.js';
import { OneDriveProvider } from './providers/OneDriveProvider.js';
import type { StorageProvider, StorageConfig, StorageStatus, RemoteData, SaveResult } from './StorageProvider.js';

/** Names identifying each account-level storage provider. */
export type ProviderName = 'gdrive' | 'dropbox' | 'onedrive';

export class StorageManager {
  /** localStorage key remembering which provider holds the account session. */
  static readonly PROVIDER_KEY = 'mp_provider';
  /** sessionStorage key set while a redirect OAuth flow is in flight — on the
   *  return URL it tells which provider must consume the OAuth parameters. */
  static readonly PENDING_KEY = 'mp_pending_provider';

  currentProvider: StorageProvider;
  _defaultProvider: StorageProvider;
  _config: StorageConfig;
  _currentName: ProviderName;

  /** Name of the provider currently selected (last picked or remembered). */
  get providerName(): ProviderName {
    return this._currentName;
  }

  constructor(config: StorageConfig = {}) {
    this._config = config;
    this._currentName = this._rememberedName();
    this._defaultProvider = this._createProvider(this._currentName);
    this.currentProvider = this._defaultProvider;
  }

  _rememberedName(): ProviderName {
    const saved = localStorage.getItem(StorageManager.PROVIDER_KEY);
    return saved === 'dropbox' || saved === 'onedrive' ? saved : 'gdrive';
  }

  _createProvider(name: ProviderName): StorageProvider {
    switch (name) {
      case 'dropbox': return new DropboxProvider(this._config.dropboxAppKey as string, this._config.fileName);
      case 'onedrive': return new OneDriveProvider(this._config.oneDriveClientId as string, this._config.fileName);
      default: return new GoogleDriveProvider(this._config.googleClientId as string, this._config.fileName, this._config.driveAppTag);
    }
  }

  /** The providers offered by the provider picker — only those the app was
   *  configured for (a missing client id/app key hides the entry). */
  availableProviders(): { name: ProviderName; label: string }[] {
    const providers: { name: ProviderName; label: string }[] = [];
    if (this._config.dropboxAppKey) providers.push({ name: 'dropbox', label: 'Dropbox' });
    if (this._config.oneDriveClientId) providers.push({ name: 'onedrive', label: 'OneDrive' });
    if (this._config.googleClientId) providers.push({ name: 'gdrive', label: 'Google Drive' });
    return providers;
  }

  /** Selects an account provider by name; it also becomes the default the
   *  app returns to after a demo session. */
  useProviderByName(name: ProviderName): void {
    this._currentName = name;
    this._defaultProvider = this._createProvider(name);
    this.currentProvider = this._defaultProvider;
  }

  /** Swaps the active provider (e.g. entering a read-only demo session). */
  useProvider(provider: StorageProvider): void {
    this.currentProvider = provider;
  }

  /** Back to the regular provider — e.g. after a demo-mode logout, so the
   *  next login targets the user's real storage again. */
  restoreDefaultProvider(): void {
    this.currentProvider = this._defaultProvider;
  }

  async initialize(): Promise<boolean> {
    if (await this.currentProvider.init()) return true;
    // The remembered provider has no session: another one might (the user
    // once connected through it without updating the remembered choice).
    for (const { name } of this.availableProviders()) {
      if (name === this._currentName) continue;
      const provider = this._createProvider(name);
      if (await provider.init()) {
        this.useProviderByName(name);
        return true;
      }
    }
    return false;
  }

  async load(): Promise<RemoteData | null> { return await this.currentProvider.load(); }
  async save(data: unknown, baseRev: string | null): Promise<SaveResult> { return await this.currentProvider.save(data, baseRev); }
  async getRemoteRevision(): Promise<string | null> { return await this.currentProvider.getRemoteRevision(); }

  async authenticate(): Promise<boolean> {
    // Redirect-flow providers leave the page; remembering which one started
    // the flow lets resumeAuth() route the return URL to it. A popup-flow
    // provider clears any stale marker left by an abandoned redirect.
    if (this.currentProvider.authResponseParams.length > 0) {
      sessionStorage.setItem(StorageManager.PENDING_KEY, this._currentName);
    } else {
      sessionStorage.removeItem(StorageManager.PENDING_KEY);
    }
    const ok = await this.currentProvider.authenticate();
    if (ok) this._rememberName();
    return ok;
  }

  /**
   * Routes an OAuth return URL to the provider that started the flow — the
   * PENDING_KEY marker first, then the connect=<name> value embedded in the
   * redirect URI as a fallback. Returns the auth verdict, or 'none' when the
   * URL carries no OAuth return parameters.
   */
  async resumeAuth(url: URL): Promise<boolean | 'none'> {
    const pending = sessionStorage.getItem(StorageManager.PENDING_KEY)
      ?? url.searchParams.get('connect')
      // Providers whose redirect URI cannot carry the connect marker
      // (OneDrive — Microsoft forbids query strings) prefix it into state.
      ?? url.searchParams.get('state')?.split(':')[0];
    if (pending === 'gdrive' || pending === 'dropbox' || pending === 'onedrive') {
      this.useProviderByName(pending);
    }
    const verdict = await this.currentProvider.resumeAuth(url);
    if (verdict === 'none') return 'none';
    sessionStorage.removeItem(StorageManager.PENDING_KEY);
    if (verdict) this._rememberName();
    return verdict;
  }

  _rememberName(): void {
    localStorage.setItem(StorageManager.PROVIDER_KEY, this._currentName);
  }

  async disconnect(): Promise<void> { await this.currentProvider.disconnect(); }
  async getStatus(): Promise<StorageStatus> { return await this.currentProvider.getStatus(); }
  async getDataLocation(): Promise<string | null> { return await this.currentProvider.getDataLocation(); }
}
