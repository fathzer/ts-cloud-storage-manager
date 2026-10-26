import type { StorageProvider } from '../StorageProvider.js';
import { IdbStore } from './LocalStore.js';
import type { LocalStore } from './LocalStore.js';

/**
 * Sentinel a MergePolicy returns when the divergence needs a user decision
 * (the engine then parks until resolveConflict / the next save).
 */
export const UNRECONCILABLE = 'unreconcilable';

/**
 * Application-supplied merge policy — the only piece knowing the shape of a
 * "grain". Called with the last-synced base, the local working copy and the
 * freshly downloaded remote data. Returns the reconciled data, or
 * UNRECONCILABLE when the conflict needs a user decision. A whole-file app
 * can pass `() => UNRECONCILABLE`.
 */
export type MergePolicy = (ctx: {
  base: unknown; local: unknown; remote: unknown;
}) => unknown;

/** Tuning knobs of a SyncEngine (constructor / StorageConfig.sync). */
export interface SyncEngineOptions {
  /** LocalStore implementation — defaults to IndexedDB (cloud-sync db). */
  store?: LocalStore;
  /** Metadata polling interval while the tab is visible; 0 disables (default 60 s). */
  pollIntervalMs?: number;
}

export type SaveVerdict = 'saved' | 'queued' | 'conflict' | 'error';

export interface SyncStatus {
  /** Unsaved local changes wait in the outbox. */
  pending: boolean;
  /** The remote file moved since base (eager pull result). */
  remoteChanged: boolean;
  /** An unreconcilable conflict parked the engine — resolveConflict required. */
  conflict: boolean;
  /** The remote data that lost the merge, when parked — for the resolution UI. */
  conflictRemote?: unknown;
  lastError?: string;
}

/**
 * Offline-first sync layer over a revision-aware StorageProvider.
 *
 * Owns the local working copy + last-synced base (persisted locally, so
 * offline edits survive a reload — 'queued' is a success verdict), the push
 * loop with optimistic-concurrency retries, merge via the app's MergePolicy,
 * and eager remote-change detection (online / visibilitychange / interval).
 * Automatic retries park on a true conflict until resolveConflict() or a new
 * save() attempt.
 */
export class SyncEngine {
  static readonly K_BASE = 'base';
  static readonly K_BASE_REV = 'baseRev';
  static readonly K_LOCAL = 'local';
  static readonly K_PENDING = 'pending';

  provider: StorageProvider;
  policy: MergePolicy;
  store: LocalStore;
  pollIntervalMs: number;

  baseRev: string | null = null;
  _base: unknown = null;
  _local: unknown = null;
  _pending = false;
  _conflict = false;
  _conflictRemote: unknown = null;
  _remoteChanged = false;
  _lastError: string | undefined;
  _syncing = false;
  _watching = false;
  _timer: ReturnType<typeof setInterval> | null = null;
  _statusCbs = new Set<(s: SyncStatus) => void>();
  _dataCbs = new Set<(data: unknown) => void>();
  _onOnline = () => { void this._syncCycle(); };
  _onVisibility = () => { if (!document.hidden) void this.pull(); };

  /**
   * @param provider the revision-aware provider to sync through.
   * @param policy the app-supplied merge policy (see {@link MergePolicy}).
   * @param options store implementation and polling interval — defaults to
   *        IndexedDB and a 60 s visible-tab poll.
   */
  constructor(provider: StorageProvider, policy: MergePolicy, options: SyncEngineOptions = {}) {
    this.provider = provider;
    this.policy = policy;
    this.store = options.store ?? new IdbStore();
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
  }

  /**
   * Restores persisted state, then syncs with the remote: a pending local
   * copy is kept (offline-first), otherwise the remote file becomes
   * base+local. Emits 'data' with the working copy.
   * @returns the local working copy to render.
   */
  async init(): Promise<unknown> {
    this._base = await this.store.get(SyncEngine.K_BASE) ?? null;
    this.baseRev = (await this.store.get(SyncEngine.K_BASE_REV) as string | null) ?? null;
    this._local = await this.store.get(SyncEngine.K_LOCAL) ?? null;
    this._pending = (await this.store.get(SyncEngine.K_PENDING) as boolean) ?? false;

    if (!this._pending) {
      try {
        const remote = await this.provider.load();
        this._base = remote?.data ?? null;
        this.baseRev = remote?.rev ?? null;
        this._local = this._base;
        await this._persist();
      } catch {
        // Offline or auth failure: keep whatever local state we have.
      }
    }
    this._startWatchers();
    this._emitStatus();
    if (this._pending) void this._syncCycle();
    this._emitData();
    return this._local;
  }

  /** @returns the current local working copy (post-init). */
  getLocal(): unknown { return this._local; }

  /**
   * Subscribes to sync-state changes; the callback fires immediately with
   * the current status.
   * @param cb receives the new {@link SyncStatus} on every change.
   * @returns an unsubscribe function.
   */
  onStatus(cb: (s: SyncStatus) => void): () => void {
    this._statusCbs.add(cb);
    cb(this._status());
    return () => this._statusCbs.delete(cb);
  }

  /**
   * Fired when the working copy is replaced by a merge/pull — re-render.
   * @param cb receives the new working copy.
   * @returns an unsubscribe function.
   */
  onData(cb: (data: unknown) => void): () => void {
    this._dataCbs.add(cb);
    return () => this._dataCbs.delete(cb);
  }

  /**
   * Records local data and pushes it. Verdicts: 'saved' (possibly after an
   * automatic merge — the working copy may then differ, see onData),
   * 'queued' (offline — durable locally), 'conflict' (parked), 'error'.
   * @param data the full data-file payload the app wants persisted.
   * @returns the push verdict; 'queued' means the edit is safe locally and
   *          will be retried when the network returns.
   */
  async save(data: unknown): Promise<SaveVerdict> {
    this._local = data;
    this._pending = true;
    this._conflict = false;
    await this._persist();
    this._emitStatus();
    return await this._push();
  }

  /**
   * Eager pull: downloads the remote when its revision moved, merges it into
   * the working copy (or parks on conflict). Cheap when nothing changed —
   * metadata only.
   * @returns resolves when the check/merge completed (or threw internally —
   *          errors land in status.lastError rather than rejecting).
   */
  async pull(): Promise<void> {
    if (this._syncing) return;
    try {
      const remoteRev = await this.provider.getRemoteRevision();
      if (remoteRev === this.baseRev) {
        if (this._remoteChanged) { this._remoteChanged = false; this._emitStatus(); }
        return;
      }
      if (remoteRev === null && this.baseRev === null) return;
      this._remoteChanged = true;
      const remote = await this.provider.load();
      const remoteData = remote?.data ?? null;
      if (!this._pending) {
        // Clean local (or remotely deleted file): remote wins wholesale.
        await this._adopt(remoteData, remote?.rev ?? null);
        return;
      }
      if (!remote) {
        // File deleted remotely with local edits — nothing to merge into.
        this._conflict = true;
        this._emitStatus();
        return;
      }
      // Both moved: policy decides.
      const merged = this.policy({ base: this._base, local: this._local, remote: remoteData });
      if (merged === UNRECONCILABLE) {
        this._conflict = true;
        this._conflictRemote = remoteData;
        this._emitStatus();
        return;
      }
      await this._adopt(merged, remote.rev);
      // The merge may still differ from remote — it gets pushed on next save.
    } catch (e) {
      this._recordError(e);
    }
  }

  /** Adopts remote data as base + working copy after a pull. */
  async _adopt(data: unknown, rev: string | null): Promise<void> {
    this._base = data;
    this.baseRev = rev;
    this._local = data;
    this._remoteChanged = false;
    await this._persist();
    this._emitData();
    this._emitStatus();
  }

  /**
   * Resolution of a parked conflict. Three forms, git-merge style:
   * 'local' force-pushes the local copy over the remote head; 'remote'
   * discards local changes and adopts remote; {merged: data} pushes a
   * reconciled version the app produced itself (e.g. an editable
   * side-by-side dialog) — the merge policy is bypassed, the write is
   * guarded on the current remote head and may conflict anew if it moved.
   * @param resolution 'local' | 'remote' | {merged: data}.
   * @returns the verdict of the resolution push ('saved' | 'conflict' |
   *          'queued' | 'error').
   */
  async resolveConflict(resolution: 'local' | 'remote' | { merged: unknown }): Promise<SaveVerdict> {
    this._conflict = false;
    this._conflictRemote = null;
    const remote = await this.provider.load().catch(() => null);
    if (remote) { this._base = remote.data; this.baseRev = remote.rev; }
    this._remoteChanged = false;
    if (resolution === 'remote') {
      this._local = this._base;
      this._pending = false;
      await this._persist();
      this._emitData();
      this._emitStatus();
      return 'saved';
    }
    // 'local' or {merged}: remote head is the base to overwrite.
    if (resolution !== 'local') {
      this._local = resolution.merged;
      this._emitData();
    }
    return await this._push();
  }

  /**
   * Swaps the underlying provider (account or provider switch). Keeps the
   * pending local edits and all subscribers, drops base/baseRev — the new
   * provider lives in a different revision namespace — then re-initializes:
   * a clean engine pulls the new remote, a dirty one pushes its pending
   * copy unconditionally, which effectively migrates it.
   * @param provider the provider to sync through from now on.
   * @returns resolves when the engine is re-initialized.
   */
  async setProvider(provider: StorageProvider): Promise<void> {
    this.provider = provider;
    this._base = null;
    this.baseRev = null;
    this._conflict = false;
    this._conflictRemote = null;
    this._remoteChanged = false;
    this._lastError = undefined;
    await this._persist();
    await this.init();
  }

  /**
   * Stops remote-change watching while keeping local state and subscribers
   * — e.g. while the app browses a read-only demo session. The next
   * {@link setProvider} or {@link init} restarts the watchers.
   */
  pause(): void { this._stopWatchers(); }

  /**
   * Clears local sync state (disconnect / account switch).
   * @returns resolves once base, working copy and outbox are purged.
   */
  async reset(): Promise<void> {
    await Promise.all(
      [SyncEngine.K_BASE, SyncEngine.K_BASE_REV, SyncEngine.K_LOCAL, SyncEngine.K_PENDING]
        .map(k => this.store.delete(k))
    );
    this._base = this._local = null;
    this.baseRev = null;
    this._pending = this._conflict = this._remoteChanged = false;
    this._conflictRemote = null;
    this._emitStatus();
  }

  /** Stops watchers and clears subscribers — call on teardown. */
  dispose(): void {
    this._stopWatchers();
    this._statusCbs.clear();
    this._dataCbs.clear();
  }

  async _push(): Promise<SaveVerdict> {
    if (this._syncing) return 'queued';
    this._syncing = true;
    try {
      const result = await this.provider.save(this._local, this.baseRev);
      if (result.status === 'saved') return await this._markSynced(result.rev);
      // Write refused: remote moved — download, merge, retry once.
      const remote = await this.provider.load();
      if (!remote) { this._conflict = true; this._emitStatus(); return 'conflict'; }
      const merged = this.policy({ base: this._base, local: this._local, remote: remote.data });
      if (merged === UNRECONCILABLE) {
        this._conflict = true;
        this._conflictRemote = remote.data;
        this._remoteChanged = true;
        this._emitStatus();
        return 'conflict';
      }
      this._local = merged;
      this._emitData();
      const retry = await this.provider.save(this._local, remote.rev);
      if (retry.status === 'saved') return await this._markSynced(retry.rev);
      this._conflict = true;
      this._emitStatus();
      return 'conflict';
    } catch (e) {
      this._recordError(e);
      // fetch throws TypeError on network failure; HTTP errors come back
      // as our own Error('... failed: HTTP xxx') messages.
      return e instanceof TypeError ? 'queued' : 'error';
    } finally {
      this._syncing = false;
    }
  }

  /** Marks the working copy as synced at the given remote revision. */
  async _markSynced(rev: string | null): Promise<SaveVerdict> {
    this._base = this._local;
    this.baseRev = rev;
    this._pending = this._remoteChanged = false;
    await this._persist();
    this._emitStatus();
    return 'saved';
  }

  /** Push pending changes (if any) then pull — the online/interval cycle. */
  async _syncCycle(): Promise<void> {
    if (this._pending && !this._conflict) {
      const verdict = await this._push();
      if (verdict === 'queued') return; // still offline — skip the pull
    }
    await this.pull();
  }

  _startWatchers(): void {
    if (this._watching || typeof window === 'undefined') return;
    this._watching = true;
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onVisibility);
    if (this.pollIntervalMs > 0) {
      this._timer = setInterval(() => {
        if (!document.hidden && navigator.onLine !== false) void this._syncCycle();
      }, this.pollIntervalMs);
    }
  }

  _stopWatchers(): void {
    if (!this._watching) return;
    this._watching = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onOnline);
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
  }

  _recordError(e: unknown): void {
    // An auth failure (token refresh dead) surfaces via the status channel:
    // callers stop retrying rather than looping on a dead session.
    if (e instanceof Error) {
      this._lastError = e.message;
    } else if (typeof e === 'object' && e !== null) {
      this._lastError = JSON.stringify(e);
    } else {
      // By elimination e is a primitive, function or null — no default
      // object stringification possible here.
      this._lastError = String(e as string | number | boolean | symbol | null | undefined);
    }
    this._emitStatus();
  }

  _status(): SyncStatus {
    return {
      pending: this._pending,
      remoteChanged: this._remoteChanged,
      conflict: this._conflict,
      conflictRemote: this._conflict ? this._conflictRemote : undefined,
      lastError: this._lastError
    };
  }

  async _persist(): Promise<void> {
    await Promise.all([
      this.store.set(SyncEngine.K_BASE, this._base),
      this.store.set(SyncEngine.K_BASE_REV, this.baseRev),
      this.store.set(SyncEngine.K_LOCAL, this._local),
      this.store.set(SyncEngine.K_PENDING, this._pending)
    ]);
  }

  _emitStatus(): void {
    const s = this._status();
    for (const cb of this._statusCbs) cb(s);
  }

  _emitData(): void {
    for (const cb of this._dataCbs) cb(this._local);
  }
}
