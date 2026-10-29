import { GoogleDriveProvider } from './providers/GoogleDriveProvider.js';
import { DropboxProvider } from './providers/DropboxProvider.js';
import { OneDriveProvider } from './providers/OneDriveProvider.js';
import { SyncEngine, UNRECONCILABLE } from './sync/SyncEngine.js';
import type { StorageProvider, StorageStatus, RemoteData, SaveResult } from './StorageProvider.js';
import type { StorageConfig } from './config.js';
import type { MergePolicy, SyncEngineOptions, SaveVerdict, SyncStatus } from './sync/SyncEngine.js';

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
  _engine: SyncEngine | null = null;

  /**
   * @returns the name of the provider currently selected (last picked or
   *          remembered).
   */
  get providerName(): ProviderName {
    return this._currentName;
  }

  /**
   * @param config provider-specific blocks; a provider is offered only when
   *        its block is present. fileName applies to every provider.
   */
  constructor(config: StorageConfig = {}) {
    this._config = config;
    this._currentName = this._rememberedName();
    this._defaultProvider = this._createProvider(this._currentName);
    this.currentProvider = this._defaultProvider;
    if (config.sync) this.enableSync(config.sync.policy ?? (() => UNRECONCILABLE), config.sync);
  }

  _rememberedName(): ProviderName {
    // The remembered choice wins only when its config block is still there;
    // otherwise fall back to the first configured provider (google keeps the
    // historic default). With no provider at all, _createProvider reports it.
    const saved = localStorage.getItem(StorageManager.PROVIDER_KEY);
    if (saved === 'dropbox' && this._config.dropbox) return 'dropbox';
    if (saved === 'onedrive' && this._config.oneDrive) return 'onedrive';
    if (saved === 'gdrive' && this._config.google) return 'gdrive';
    if (this._config.google) return 'gdrive';
    if (this._config.dropbox) return 'dropbox';
    if (this._config.oneDrive) return 'onedrive';
    return 'gdrive';
  }

  _createProvider(name: ProviderName): StorageProvider {
    switch (name) {
      case 'dropbox':
        if (!this._config.dropbox) throw new Error('StorageManager: no dropbox config block');
        return new DropboxProvider(this._config.dropbox.appKey, this._config.fileName);
      case 'onedrive':
        if (!this._config.oneDrive) throw new Error('StorageManager: no oneDrive config block');
        return new OneDriveProvider(this._config.oneDrive.clientId, this._config.fileName);
      default: {
        const google = this._config.google;
        if (!google) throw new Error('StorageManager: no google config block (at least one provider block is required)');
        return new GoogleDriveProvider(google.clientId, {
          fileName: this._config.fileName,
          appTag: google.appTag,
          confirmDialog: google.confirmDialog
        });
      }
    }
  }

  /**
   * @returns the providers offered by the provider picker — only those
   *          whose config block is present (a missing block hides the
   *          entry).
   */
  availableProviders(): { name: ProviderName; label: string }[] {
    const providers: { name: ProviderName; label: string }[] = [];
    if (this._config.dropbox) providers.push({ name: 'dropbox', label: 'Dropbox' });
    if (this._config.oneDrive) providers.push({ name: 'onedrive', label: 'OneDrive' });
    if (this._config.google) providers.push({ name: 'gdrive', label: 'Google Drive' });
    return providers;
  }

  /**
   * Enables offline-first sync: creates (or returns) the SyncEngine wrapped
   * around the active provider. The manager then owns its whole lifecycle —
   * init on session restore, provider re-wrap on switches, pause during
   * read-only sessions, state purge on disconnect.
   * @param policy the app-supplied merge policy (defaults to
   *        always-UNRECONCILABLE: every divergence parks).
   * @param options store implementation and polling interval.
   * @returns the managed SyncEngine — subscribe/save through it.
   */
  enableSync(policy: MergePolicy = () => UNRECONCILABLE, options: SyncEngineOptions = {}): SyncEngine {
    this._engine ??= new SyncEngine(this.currentProvider, policy, options);
    return this._engine;
  }

  /** @returns the engine created by the `sync` config block or
   *          {@link enableSync}, null when sync is disabled. */
  get syncEngine(): SyncEngine | null { return this._engine; }

  _requireEngine(): SyncEngine {
    if (!this._engine) throw new Error('Sync is not enabled — pass a config.sync block or call enableSync()');
    return this._engine;
  }

  /**
   * Subscribes to sync-state changes (forwarded to the managed engine).
   * @param cb receives the new {@link SyncStatus} on every change.
   * @returns an unsubscribe function.
   */
  onStatus(cb: (s: SyncStatus) => void): () => void { return this._requireEngine().onStatus(cb); }

  /**
   * Fired when the working copy is replaced by a merge/pull — re-render
   * (forwarded to the managed engine).
   * @param cb receives the new working copy.
   * @returns an unsubscribe function.
   */
  onData(cb: (data: unknown) => void): () => void { return this._requireEngine().onData(cb); }

  /**
   * Resolves a parked conflict (forwarded to the managed engine).
   * @param resolution 'local' | 'remote' | {merged: data}.
   * @returns the verdict of the resolution push.
   */
  resolveConflict(resolution: 'local' | 'remote' | { merged: unknown }): Promise<SaveVerdict> {
    return this._requireEngine().resolveConflict(resolution);
  }

  /**
   * Eager remote-change check + merge (forwarded to the managed engine).
   * @returns resolves when the check/merge completed.
   */
  pull(): Promise<void> { return this._requireEngine().pull(); }

  /**
   * Selects an account provider by name; it also becomes the default the
   * app returns to after a demo session. A managed engine is re-wrapped
   * around the new provider.
   * @param name one of {@link availableProviders}' names.
   */
  useProviderByName(name: ProviderName): void {
    this._currentName = name;
    this._defaultProvider = this._createProvider(name);
    this.currentProvider = this._defaultProvider;
    this._resync();
  }

  /**
   * Swaps the active provider (e.g. entering a read-only demo session).
   * A managed engine pauses on read-only providers — the account's sync
   * state is preserved — and is re-wrapped otherwise.
   * @param provider the provider instance to activate.
   */
  useProvider(provider: StorageProvider): void {
    this.currentProvider = provider;
    if (provider.isReadOnly()) {
      this._engine?.pause();
    } else {
      this._resync();
    }
  }

  /**
   * Back to the regular provider — e.g. after a demo-mode logout, so the
   * next login targets the user's real storage again. A managed engine is
   * re-wrapped (its state survived the pause).
   */
  restoreDefaultProvider(): void {
    this.currentProvider = this._defaultProvider;
    this._resync();
  }

  /** Re-wraps the managed engine around the current provider, if enabled. */
  _resync(): void { void this._engine?.setProvider(this.currentProvider); }

  /**
   * Tries the remembered provider first, then every configured one: the user
   * may have a session under another provider. The managed engine is
   * re-wrapped around whichever provider restored a session.
   * @returns true when a provider restored a session.
   */
  async initialize(): Promise<boolean> {
    let found = await this.currentProvider.init();
    // The remembered provider has no session: another one might (the user
    // once connected through it without updating the remembered choice).
    for (const { name } of this.availableProviders()) {
      if (found || name === this._currentName) continue;
      const provider = this._createProvider(name);
      if (await provider.init()) {
        // Fields set directly — the engine is re-wrapped below.
        this._currentName = name;
        this._defaultProvider = provider;
        this.currentProvider = provider;
        found = true;
      }
    }
    if (!found) return false;
    if (this.currentProvider.isReadOnly()) {
      // Read-only sessions (demo) pause the engine — never re-wrap it:
      // pending account edits must not be pushed into a silent no-op save.
      this._engine?.pause();
    } else if (this._engine?.provider === this.currentProvider) {
      await this._engine.init();
    } else {
      await this._engine?.setProvider(this.currentProvider);
    }
    return true;
  }

  /** @returns see {@link StorageProvider.load}. */
  async load(): Promise<RemoteData | null> { return await this.currentProvider.load(); }
  /**
   * Saves through the managed SyncEngine when sync is enabled and no
   * baseRev is passed — the engine owns revisions then — otherwise falls
   * back to the raw provider-level guarded write.
   * @param data the full data-file payload to write.
   * @param baseRev raw-mode revision guard; omit when sync is enabled.
   * @returns a {@link SaveVerdict} through the engine, a {@link SaveResult}
   *          in raw mode.
   */
  save(data: unknown): Promise<SaveVerdict>;
  save(data: unknown, baseRev: string | null): Promise<SaveResult>;
  async save(data: unknown, baseRev?: string | null): Promise<SaveVerdict | SaveResult> {
    if (this._engine && baseRev === undefined) return await this._engine.save(data);
    return await this.currentProvider.save(data, baseRev ?? null);
  }
  /** @returns see {@link StorageProvider.getRemoteRevision}. */
  async getRemoteRevision(): Promise<string | null> { return await this.currentProvider.getRemoteRevision(); }

  /**
   * @returns true when the active provider is connected (redirect flows
   *          never resolve — see {@link resumeAuth}).
   */
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
    if (ok) {
      this._rememberName();
      await this._engine?.init();
    }
    return ok;
  }

  /**
   * Routes an OAuth return URL to the provider that started the flow — the
   * PENDING_KEY marker first, then the connect=<name> value embedded in the
   * redirect URI as a fallback.
   * @param url the full URL the OAuth provider redirected back to.
   * @returns the auth verdict, or 'none' when the URL carries no OAuth
   *          return parameters.
   */
  async resumeAuth(url: URL): Promise<boolean | 'none'> {
    const pending = sessionStorage.getItem(StorageManager.PENDING_KEY)
      ?? url.searchParams.get('connect')
      // Providers whose redirect URI cannot carry the connect marker
      // (OneDrive — Microsoft forbids query strings) prefix it into state.
      ?? url.searchParams.get('state')?.split(':')[0];
    // The hint is untrusted URL data: route only to providers that are
    // actually configured — a connect=<name> deep link (or a forged state
    // prefix) naming an absent provider must not crash the boot.
    if (this.availableProviders().some(p => p.name === pending)) {
      this.useProviderByName(pending as ProviderName);
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

  /**
   * Ends the session and purges the managed engine's sync state (base,
   * working copy, outbox) — the next login starts from a clean slate.
   * @returns resolves once the session is cleared.
   */
  async disconnect(): Promise<void> {
    await this._engine?.reset();
    await this.currentProvider.disconnect();
  }
  /** @returns see {@link StorageProvider.getStatus}. */
  async getStatus(): Promise<StorageStatus> { return await this.currentProvider.getStatus(); }
  /** @returns see {@link StorageProvider.getDataLocation}. */
  async getDataLocation(): Promise<string | null> { return await this.currentProvider.getDataLocation(); }
}
