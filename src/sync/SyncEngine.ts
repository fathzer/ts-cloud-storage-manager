import type { StorageProvider, RemoteData, SaveResult } from '../StorageProvider.js';
import { IdbStore } from './LocalStore.js';
import type { LocalStore } from './LocalStore.js';
import { decide, hashAll, sha256Hasher, wholeFileCodec } from './grains.js';
import type { GrainCodec, GrainHasher, GrainId } from './grains.js';

/** Tuning knobs of a SyncEngine (constructor / StorageConfig.sync). */
export interface SyncEngineOptions {
  /** LocalStore implementation — defaults to IndexedDB (StorageManager
   *  supplies a namespace-derived database name; a directly constructed
   *  engine falls back to 'cloud-sync'). */
  store?: LocalStore;
  /** Metadata polling interval while the tab is visible; 0 disables (default 60 s). */
  pollIntervalMs?: number;
  /**
   * When false, the watchers only *detect* remote changes (remoteChanged
   * flag) — adoption/merge waits for an explicit pull(), e.g. behind a
   * "new version available" button. Default true.
   */
  eagerPull?: boolean;
  /**
   * How the data file is cut into grains, the independently reconcilable
   * pieces. Default: the whole file is one grain — any divergence of the
   * file is then a conflict the user resolves.
   */
  grains?: GrainCodec;
  /**
   * Content hash of a grain — must be deterministic and equal for equal
   * content. Default: SHA-256 of the grain's canonical JSON.
   */
  hash?: GrainHasher;
}

export type SaveVerdict = 'saved' | 'queued' | 'conflict' | 'error';

/** A grain edited differently on both sides, as shown to the user. */
export interface ConflictInfo {
  id: GrainId;
  /** The local version, null when the grain is deleted locally. */
  local: unknown;
  /** The cloud version, null when the grain is deleted in the cloud. */
  remote: unknown;
}

/** The user's decision for one conflicting grain. `{ merged }` is a version
 *  the app produced itself (null deletes the grain); it is then pushed. */
export type ConflictChoice = 'local' | 'remote' | { merged: unknown };

/** Resolution of a parked conflict: one choice per conflicting grain, or a
 *  single side for all of them. */
export type Resolution = 'local' | 'remote' | Record<GrainId, ConflictChoice>;

export interface SyncStatus {
  /** Unsaved local changes wait in the outbox. */
  pending: boolean;
  /** The remote file moved since it was last read (eager pull result). */
  remoteChanged: boolean;
  /** Grains edited differently on both sides parked the engine —
   *  resolveConflict required. */
  conflict: boolean;
  /** The conflicting grains, both sides — for the resolution UI. */
  conflicts?: ConflictInfo[];
  /** Timestamp (ms) of the next scheduled push retry, when queued/failed. */
  nextRetryAt?: number;
  lastError?: string;
}

/** A merge the engine could not decide: the cloud version it was compared
 *  with, kept until the user decides. */
interface Parked {
  remote: Map<GrainId, unknown>;
  cloudRev: string | null;
  conflicts: GrainId[];
}

/** Persisted form of {@link Parked} (Maps flattened to entry lists). */
interface StoredParked {
  remote: [GrainId, unknown][];
  cloudRev: string | null;
  conflicts: GrainId[];
}

/** What a reconciliation did: 'clean' = local now equals the cloud, 'merged'
 *  = local edits remain to push, 'retry' = the working copy changed while
 *  deciding (the decision is void). */
type Reconciliation = 'clean' | 'merged' | 'conflict' | 'retry';

/**
 * Offline-first sync layer over a revision-aware StorageProvider.
 *
 * Owns the local working copy (persisted locally, so offline edits survive
 * a reload — 'queued' is a success verdict) and, per grain, the hash of the
 * cloud version it was read from. Those hashes — never a copy of the source
 * data — are what tells a local edit from a remote one: the push loop is
 * guarded by the revision it read, and a refused write reloads the cloud
 * file and decides grain by grain (see {@link decide}). Edits made on both
 * sides to the same grain park the engine until resolveConflict().
 */
export class SyncEngine {
  static readonly K_LOCAL = 'local';
  static readonly K_PENDING = 'pending';
  static readonly K_READ_REV = 'readRev';
  static readonly K_SOURCE_HASH = 'sourceHash';
  static readonly K_PARKED = 'parked';
  /** Pushes/merges attempted before giving up until the next cycle — the
   *  cloud keeps moving under us, or the user keeps editing. */
  static readonly MAX_ATTEMPTS = 5;

  provider: StorageProvider;
  store: LocalStore;
  pollIntervalMs: number;
  eagerPull: boolean;
  codec: GrainCodec;
  hasher: GrainHasher;

  /** Revision of the cloud file the local copy was last read from or pushed
   *  to — the write guard. Null: no file at that time. */
  readRev: string | null = null;
  _data: unknown = null;
  /** Hashes of the cloud grains at readRev (absent grains are not listed). */
  _sourceHash = new Map<GrainId, string>();
  /** Bumped by every save(): tells a push or merge in flight that the
   *  working copy moved under it. */
  _version = 0;
  _pending = false;
  _parked: Parked | null = null;
  _remoteChanged = false;
  _lastError: string | undefined;
  _nextRetryAt: number | undefined;
  _syncing = false;
  /** A save() arrived while a pull held the engine: push once it is done. */
  _pushRequested = false;
  _watching = false;
  _timer: ReturnType<typeof setInterval> | null = null;
  _statusCbs = new Set<(s: SyncStatus) => void>();
  _dataCbs = new Set<(data: unknown) => void>();
  _onOnline = () => { void this._syncCycle(); };
  _onVisibility = () => { if (!document.hidden) void this.pull(); };

  /**
   * @param provider the revision-aware provider to sync through.
   * @param options grain codec, store implementation and polling interval —
   *        defaults to a single whole-file grain, IndexedDB and a 60 s
   *        visible-tab poll.
   */
  constructor(provider: StorageProvider, options: SyncEngineOptions = {}) {
    this.provider = provider;
    this.store = options.store ?? new IdbStore();
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.eagerPull = options.eagerPull !== false;
    this.codec = options.grains ?? wholeFileCodec;
    this.hasher = options.hash ?? sha256Hasher;
  }

  /**
   * Restores persisted state, then syncs with the remote: a pending local
   * copy (or a parked conflict) is kept (offline-first), otherwise the
   * remote file becomes the local copy. Emits 'data' with the working copy.
   * @returns the local working copy to render.
   */
  async init(): Promise<unknown> {
    const get = (key: string) => this.store.get(key);
    this._data = await get(SyncEngine.K_LOCAL) ?? null;
    this._pending = (await get(SyncEngine.K_PENDING) as boolean | undefined) ?? false;
    this.readRev = (await get(SyncEngine.K_READ_REV) as string | null | undefined) ?? null;
    this._sourceHash = new Map(await get(SyncEngine.K_SOURCE_HASH) as [GrainId, string][] | undefined ?? []);
    const parked = await get(SyncEngine.K_PARKED) as StoredParked | null | undefined;
    this._parked = parked
      ? { remote: new Map(parked.remote), cloudRev: parked.cloudRev, conflicts: parked.conflicts }
      : null;

    if (!this._pending && !this._parked) {
      try {
        await this._adoptRemote(await this.provider.load());
      } catch (e) {
        // Offline or auth failure: keep whatever local state we have —
        // lastError lets the app tell "no remote file" from "load failed".
        this._recordError(e);
      }
    }
    this._startWatchers();
    this._emitStatus();
    if (this._pending && !this._parked) void this._syncCycle();
    this._emitData();
    return this._data;
  }

  /** @returns the current local working copy (post-init). */
  getLocal(): unknown { return this._data; }

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
   * 'queued' (offline or busy — durable locally), 'conflict' (parked: the
   * edit is kept locally but nothing is pushed until resolveConflict()),
   * 'error'.
   * @param data the full data-file payload the app wants persisted.
   * @returns the push verdict; 'queued' means the edit is safe locally and
   *          will be retried when the network returns.
   */
  async save(data: unknown): Promise<SaveVerdict> {
    this._data = data;
    this._version++;
    this._pending = true;
    await this._persist();
    this._emitStatus();
    return await this._push();
  }

  /**
   * Eager pull: downloads the remote when its revision moved and merges it
   * into the working copy grain by grain (or parks on conflict). Cheap when
   * nothing changed — metadata only. Local edits that survive the merge are
   * pushed right after.
   * @returns resolves when the check/merge completed (or threw internally —
   *          errors land in status.lastError rather than rejecting).
   */
  async pull(): Promise<void> {
    if (this._syncing || this._parked) return;
    this._syncing = true;
    let hasEditsToPush = false;
    try {
      if (!await this._detect()) return;
      for (let attempt = 0; attempt < SyncEngine.MAX_ATTEMPTS; attempt++) {
        const outcome = await this._reconcile(await this.provider.load());
        if (outcome === 'retry') continue;
        hasEditsToPush = outcome === 'merged';
        return;
      }
    } catch (e) {
      this._recordError(e);
    } finally {
      this._syncing = false;
      if (this._pushRequested || hasEditsToPush) {
        this._pushRequested = false;
        void this._push();
      }
    }
  }

  /**
   * Metadata-only remote-change check — cheap.
   * @returns whether the remote file moved since readRev; remoteChanged is
   *          set/cleared accordingly.
   */
  async _detect(): Promise<boolean> {
    const remoteRev = await this.provider.getRemoteRevision();
    if (remoteRev === this.readRev) {
      if (this._remoteChanged) { this._remoteChanged = false; this._emitStatus(); }
      return false;
    }
    this._remoteChanged = true;
    this._emitStatus();
    return true;
  }

  /**
   * Resolution of a parked conflict. Each conflicting grain gets a choice:
   * 'local' keeps and pushes this device's version, 'remote' takes the
   * cloud's, `{ merged }` pushes a version the app produced itself (e.g. an
   * editable side-by-side dialog; null deletes the grain). A plain
   * 'local' / 'remote' applies to every conflicting grain. Grains are
   * resolved one by one: a choice is applied at once and the engine stays
   * parked on the grains left undecided — including conflicts that appeared
   * while parked, since the working copy was edited meanwhile. Nothing is
   * pushed until none is left.
   * @param resolution one side for all, or `{ [grainId]: choice }`.
   * @returns the verdict of the resolution push ('saved' | 'conflict' |
   *          'queued' | 'error'); 'conflict' while grains remain undecided.
   */
  async resolveConflict(resolution: Resolution): Promise<SaveVerdict> {
    const parked = this._parked;
    if (!parked) return await this._push();
    if (this._syncing) return 'queued';
    const version = this._version;
    const choiceOf = (id: GrainId): ConflictChoice | undefined =>
      typeof resolution === 'string' ? resolution : resolution[id];

    const localGrains = this.codec.split(this._data);
    let edited = false;
    for (const id of parked.conflicts) {
      const choice = choiceOf(id);
      if (typeof choice !== 'object') continue;
      edited = true;
      if (choice.merged == null) localGrains.delete(id); else localGrains.set(id, choice.merged);
    }
    const [localHash, remoteHash] = await Promise.all([
      hashAll(localGrains, this.hasher), hashAll(parked.remote, this.hasher)
    ]);
    if (this._version !== version) return await this.resolveConflict(resolution);

    const { keepLocal, conflicts } = decide(localHash, remoteHash, this._sourceHash);
    const undecided = conflicts.filter(id => choiceOf(id) === undefined);
    if (undecided.length > 0) {
      // Apply the choices made so far, grain by grain: each decided grain
      // takes the cloud version as its source (the source hashes are per
      // grain), so it stops conflicting. Nothing is pushed while a grain
      // is undecided, hence readRev stays as it was.
      const sourceHash = new Map(this._sourceHash);
      let changed = edited;
      for (const id of conflicts.filter(id => !undecided.includes(id))) {
        if (choiceOf(id) === 'remote') {
          if (localHash.get(id) !== remoteHash.get(id)) changed = true;
          if (parked.remote.has(id)) localGrains.set(id, parked.remote.get(id)); else localGrains.delete(id);
        }
        const hash = remoteHash.get(id);
        if (hash === undefined) sourceHash.delete(id); else sourceHash.set(id, hash);
      }
      this._sourceHash = sourceHash;
      this._parked = { ...parked, conflicts: undecided };
      if (changed) this._data = this.codec.join(localGrains);
      await this._persist();
      if (changed) this._emitData();
      this._emitStatus();
      return 'conflict';
    }
    for (const id of conflicts) if (choiceOf(id) !== 'remote') keepLocal.add(id);
    await this._applyMerge({
      localGrains, localHash, remoteGrains: parked.remote, remoteHash, cloudRev: parked.cloudRev, keepLocal, edited
    });
    return await this._push();
  }

  /**
   * Swaps the underlying provider (account or provider switch). Keeps the
   * pending local edits and all subscribers, forgets what was read — the
   * new provider lives in a different revision namespace — then
   * re-initializes: a clean engine pulls the new remote, a dirty one merges
   * its pending edits into whatever the new remote already holds (every
   * local grain counts as edited).
   * @param provider the provider to sync through from now on.
   * @returns resolves when the engine is re-initialized.
   */
  async setProvider(provider: StorageProvider): Promise<void> {
    this.provider = provider;
    this._sourceHash = new Map();
    this.readRev = null;
    this._parked = null;
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
   * @returns resolves once the working copy, hashes and outbox are purged.
   */
  async reset(): Promise<void> {
    await Promise.all(
      [SyncEngine.K_LOCAL, SyncEngine.K_PENDING, SyncEngine.K_READ_REV, SyncEngine.K_SOURCE_HASH, SyncEngine.K_PARKED]
        .map(k => this.store.delete(k))
    );
    this._data = null;
    this._sourceHash = new Map();
    this.readRev = null;
    this._parked = null;
    this._pending = this._remoteChanged = false;
    this._emitStatus();
  }

  /** Stops watchers and clears subscribers — call on teardown. */
  dispose(): void {
    this._stopWatchers();
    this._statusCbs.clear();
    this._dataCbs.clear();
  }

  /** Makes the cloud file (or its absence) the working copy and the source. */
  async _adoptRemote(remote: RemoteData | null): Promise<void> {
    this._data = remote?.data ?? null;
    this._sourceHash = await hashAll(this.codec.split(this._data), this.hasher);
    this.readRev = remote?.rev ?? null;
    await this._persist();
  }

  async _push(): Promise<SaveVerdict> {
    if (this._parked) return 'conflict';
    if (this._syncing) {
      this._pushRequested = true;
      return 'queued';
    }
    if (!this._pending) return 'saved';
    this._syncing = true;
    try {
      return await this._pushLoop();
    } catch (e) {
      // A scheduled retry is coming (poll, online, visibility) — tell the
      // UI when it lands.
      if (this.pollIntervalMs > 0) this._nextRetryAt = Date.now() + this.pollIntervalMs;
      this._recordError(e);
      // fetch throws TypeError on network failure; HTTP errors come back
      // as our own Error('... failed: HTTP xxx') messages.
      return e instanceof TypeError ? 'queued' : 'error';
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Pushes a frozen snapshot of the working copy, guarded by readRev. When
   * the cloud refuses (it moved), reconciles grain by grain and goes again —
   * the cloud may have moved once more. Edits saved meanwhile are picked up
   * by the next iteration.
   */
  async _pushLoop(): Promise<SaveVerdict> {
    for (let attempt = 0; attempt < SyncEngine.MAX_ATTEMPTS && this._pending; attempt++) {
      const version = this._version;
      const snapshot = structuredClone(this._data);
      const snapHash = await hashAll(this.codec.split(snapshot), this.hasher);
      const res = await this._guardedSave(snapshot);
      if (res.status === 'saved') {
        this._sourceHash = snapHash; // what the cloud holds now — not the live working copy
        this.readRev = res.rev;
        this._pending = this._version !== version;
        this._remoteChanged = false;
        this._lastError = undefined;
        this._nextRetryAt = undefined;
        await this._persist();
        this._emitStatus();
        continue;
      }
      if (await this._reconcile(await this.provider.load()) === 'conflict') return 'conflict';
    }
    if (!this._pending) return 'saved';
    // Too much contention: the next cycle retries.
    if (this.pollIntervalMs > 0) this._nextRetryAt = Date.now() + this.pollIntervalMs;
    this._emitStatus();
    return 'queued';
  }

  /**
   * Providers treat a null revision as an unconditional write: when no file
   * was known, check none appeared meanwhile and report a conflict if one
   * did, so a first save never overwrites another device's.
   */
  async _guardedSave(snapshot: unknown): Promise<SaveResult> {
    if (this.readRev === null && await this.provider.getRemoteRevision() !== null) return { status: 'conflict' };
    return await this.provider.save(snapshot, this.readRev);
  }

  /**
   * Decides grain by grain between the working copy and a cloud version,
   * then applies the merge — or parks when the same grain was edited
   * differently on both sides.
   */
  async _reconcile(remote: RemoteData | null): Promise<Reconciliation> {
    const version = this._version;
    const remoteGrains = this.codec.split(remote?.data ?? null);
    const localGrains = this.codec.split(this._data);
    const [remoteHash, localHash] = await Promise.all([
      hashAll(remoteGrains, this.hasher), hashAll(localGrains, this.hasher)
    ]);
    if (this._version !== version) return 'retry';

    const { keepLocal, conflicts } = decide(localHash, remoteHash, this._sourceHash);
    const cloudRev = remote?.rev ?? null;
    if (conflicts.length > 0) {
      this._parked = { remote: remoteGrains, cloudRev, conflicts };
      this._remoteChanged = true;
      await this._persist();
      this._emitStatus();
      return 'conflict';
    }
    await this._applyMerge({ localGrains, localHash, remoteGrains, remoteHash, cloudRev, keepLocal, edited: false });
    return keepLocal.size === 0 ? 'clean' : 'merged';
  }

  /**
   * Builds the working copy from the decision — the cloud version of every
   * grain, except those in keepLocal — and records the cloud version as the
   * new source: its hashes and revision, NOT those of the kept local grains,
   * which stay edits to push. Persisted in one atomic write.
   */
  async _applyMerge(m: {
    localGrains: Map<GrainId, unknown>; localHash: Map<GrainId, string>;
    remoteGrains: Map<GrainId, unknown>; remoteHash: Map<GrainId, string>;
    cloudRev: string | null; keepLocal: Set<GrainId>;
    /** The local grains already differ from the working copy (chosen merges). */
    edited: boolean;
  }): Promise<void> {
    const merged = new Map<GrainId, unknown>();
    let changed = m.edited;
    for (const id of new Set([...m.localGrains.keys(), ...m.remoteGrains.keys()])) {
      if (m.keepLocal.has(id)) {
        if (m.localGrains.has(id)) merged.set(id, m.localGrains.get(id));
        continue;
      }
      if (m.localHash.get(id) !== m.remoteHash.get(id)) changed = true;
      if (m.remoteGrains.has(id)) merged.set(id, m.remoteGrains.get(id));
    }
    // No file at all stays "no data", distinct from an empty file.
    if (changed) this._data = merged.size === 0 && m.cloudRev === null ? null : this.codec.join(merged);
    this._sourceHash = new Map(m.remoteHash);
    this.readRev = m.cloudRev;
    this._pending = m.keepLocal.size > 0;
    this._remoteChanged = false;
    this._parked = null;
    await this._persist();
    if (changed) this._emitData();
    this._emitStatus();
  }

  /** Push pending changes (if any) then pull or detect — the online/interval cycle. */
  async _syncCycle(): Promise<void> {
    if (this._pending && !this._parked) {
      const verdict = await this._push();
      if (verdict === 'queued') return; // still offline — skip the pull
    }
    if (this.eagerPull) {
      await this.pull();
    } else if (!this._syncing) {
      try { await this._detect(); } catch (e) { this._recordError(e); }
    }
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
    // callers stop retrying rather than looping on a dead session. The full
    // error is also logged — the status string alone is too terse to
    // diagnose a provider failure.
    console.error('SyncEngine error:', e);
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
    const parked = this._parked;
    return {
      pending: this._pending,
      remoteChanged: this._remoteChanged,
      conflict: parked !== null,
      conflicts: parked ? this._conflictInfos(parked) : undefined,
      // Retries are paused while parked — no point advertising a retry time.
      nextRetryAt: parked ? undefined : this._nextRetryAt,
      lastError: this._lastError
    };
  }

  _conflictInfos(parked: Parked): ConflictInfo[] {
    const local = this.codec.split(this._data);
    return parked.conflicts.map(id => ({
      id, local: local.get(id) ?? null, remote: parked.remote.get(id) ?? null
    }));
  }

  async _persist(): Promise<void> {
    const parked: StoredParked | null = this._parked && {
      remote: [...this._parked.remote], cloudRev: this._parked.cloudRev, conflicts: this._parked.conflicts
    };
    await this.store.setMany([
      [SyncEngine.K_LOCAL, this._data],
      [SyncEngine.K_PENDING, this._pending],
      [SyncEngine.K_READ_REV, this.readRev],
      [SyncEngine.K_SOURCE_HASH, [...this._sourceHash]],
      [SyncEngine.K_PARKED, parked]
    ]);
  }

  _emitStatus(): void {
    const s = this._status();
    for (const cb of this._statusCbs) cb(s);
  }

  _emitData(): void {
    for (const cb of this._dataCbs) cb(this._data);
  }
}
