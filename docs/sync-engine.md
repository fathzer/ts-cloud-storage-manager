# Sync engine — design

The `SyncEngine` adds **offline-first editing** and **multi-device sync** on
top of the revision-aware `StorageProvider` contract. The app keeps a
durable local working copy (IndexedDB — a small database built into the
browser), writes go there first, and the cloud file is a replica synced in
the background.

## Implementation status

**Implemented:**

- Durable local state in a pluggable `LocalStore` — `IdbStore` (IndexedDB)
  by default, `MemoryStore` for tests: the working copy, the `pending`
  flag, `readRev` (the cloud revision the copy was read from), the
  per-grain **source hashes** and a parked conflict, written together in
  one atomic `setMany`.
- Push loop guarded by `readRev`, with grain-by-grain reconciliation when
  the cloud refuses the write (see below).
- Conflict **parking** on grains edited differently on both sides, and a
  per-grain resolution (`resolveConflict('local' | 'remote' | { id: choice })`).
- Eager pull — `getRemoteRevision()` on `online`, `visibilitychange` and a
  visible-tab interval (`pollIntervalMs`, 60 s default). Optional
  detect-only mode (`eagerPull: false`): the watchers flag `remoteChanged`
  without merging — drives a "new version available" UX where adoption
  waits for an explicit `pull()`.
- `nextRetryAt` in the status — the scheduled push-retry time when a save
  queued/failed, for "retry at HH:MM" UI. `lastError` also records init
  load failures (so "no remote file" and "load failed" stay distinct).
- Status channel: `pending`, `remoteChanged`, `conflict`, `conflicts` (both
  sides of every conflicting grain, for the resolution UI), `lastError`.
- Offline detection by network failure (the fetch `TypeError`), `'queued'`
  verdict, `reset()` on disconnect.
- **Manager-owned lifecycle** — a `sync` block in `StorageConfig` (or
  `storage.enableSync()`) creates the engine; `StorageManager` then inits
  it on session restore, re-wraps it on provider switches (pending edits
  merge into the new provider's file), pauses it during read-only sessions
  and purges it on `disconnect()`. The whole sync API is reachable on the
  manager (`save(data)`, `onStatus`, `onData`, `resolveConflict`, `pull`) —
  apps never touch the engine directly unless they want to.

**Possible extensions — not implemented:**

- Provider push channels: `watchRemoteChanges(onChange, signal:
  AbortSignal)` — Dropbox `longpoll` wrapped as serverless push
  (needs a cursor from `get_latest_cursor`, honors `backoff`, no
  `Authorization` header, folder-scoped signal → re-check the file rev).
- Multi-tab coordination: `navigator.locks` (one leader tab pushes and
  polls, since the IndexedDB queue is shared) + `BroadcastChannel` to wake
  followers.
- Atomic create-if-absent for the very first write (see "First write").
- Field-level merge inside a grain: a finer grain codec does it today.

## The model

The data file is cut into **grains** by the app's `GrainCodec`:

```ts
interface GrainCodec {
  split(data: unknown): Map<GrainId, unknown>; // grains by id, in display order
  join(grains: Map<GrainId, unknown>): unknown; // the payload back
}
```

That is the only app-specific code sync needs. Omitted, the file is one
grain (`WHOLE_FILE_GRAIN`, id `''`): the conservative whole-file stance —
any divergence of the file is a conflict.

The engine keeps, besides the working copy, **no copy of the data it was
read from** — only:

```
readRev      the cloud revision the working copy was read from / pushed to
             (null: there was no file)
sourceHash   grain id → hash of that cloud version's grain
```

A grain's hash (SHA-256 of its canonical JSON by default, `hash` option to
override) is all that is needed to tell *"I edited this grain"* (its hash
differs from `sourceHash`) from *"the cloud edited it"* (the cloud's hash
differs from `sourceHash`). A grain absent on a side hashes to `null`, so
deletions and creations fall out of the same rules — there are no
tombstones, no `dirty` markers and no revision stamped inside the data.

### The decision

For every grain id of the local copy, the cloud version and `sourceHash`:

| local vs source | local vs remote | remote vs source | verdict |
|---|---|---|---|
| same (not edited here) | — | — | take the cloud version (or its deletion) |
| edited | same (same edit) | — | nothing to do |
| edited | different | same (not edited there) | keep local, push it |
| edited | different | edited | **conflict** |

Which gives, among others:

| case | local | source | remote | verdict |
|---|---|---|---|---|
| local deletion, cloud untouched | absent | h | h | deletion kept |
| local deletion, cloud edited | absent | h | h' | conflict |
| remote deletion, local untouched | h | h | absent | dropped |
| remote deletion, local edit | h' | h | absent | conflict |
| created in the cloud | absent | absent | h | taken (not mistaken for a local deletion) |
| created here | h | absent | absent | kept and pushed |
| created on both sides, different content | h | absent | h' | conflict |

The decision is the pure function `decide(local, remote, source)` of
`src/sync/grains.ts`.

## How a save flows

1. `save(data)` writes the data into the local store and flags it `pending`
   — **this is the durable point**: after it, a crash or network loss loses
   nothing.
2. The engine pushes a **frozen snapshot** of the working copy, guarded by
   `readRev`. Edits saved while the push is in flight are not lost: they
   are picked up by the next iteration of the loop, and `save()` meanwhile
   returns `'queued'`.
3. Outcomes:
   - **saved** — `readRev` becomes the new revision and the source hashes
     become those of the *pushed snapshot* (not of the live working copy,
     which may have moved on); `pending` clears unless something was saved
     meanwhile.
   - **refused** (the cloud moved) — the cloud file is downloaded, every
     grain is decided as above and the working copy is rebuilt: the cloud
     version of each grain except the ones kept local. The cloud version —
     its hashes and revision, **not** the kept local grains' — becomes the
     new source, so the kept edits remain edits. If nothing local remains
     the engine stops (nothing to push); otherwise it loops and pushes
     again, because the cloud may have moved once more. `onData` fires when
     the merge changed the working copy; the caller only sees `'saved'`.
   - **conflict** — the engine **parks**: the cloud version, its revision
     and the conflicting ids are persisted, `conflict` + `conflicts` are
     exposed, nothing is applied or pushed. Edits made while parked stay
     local (`save()` returns `'conflict'`).
   - **network error** — verdict `'queued'`, a success: the edit waits in
     the outbox and the cycle retries on `online`/`visibilitychange`/poll.
   - **other error** — verdict `'error'`, `lastError` set; pending data is
     kept.
   - too much contention (5 attempts) — `'queued'`, retried on the next
     cycle.
4. `pull()` (eager) does the same reconciliation when the remote revision
   changed while the user was away — without needing a refused write first.
   A clean working copy simply takes the cloud version; kept local edits are
   pushed right after.

### Resolving a conflict

`resolveConflict(resolution)` takes, for each conflicting grain:

- `'local'` — keep this device's version and push it;
- `'remote'` — take the cloud's version (or its deletion);
- `{ merged }` — push a version the app built itself (`null` deletes the
  grain), e.g. from an editable side-by-side dialog.

A plain `'local'` / `'remote'` applies to every conflicting grain; an
object maps grain ids to choices.

Conflicts are resolved **grain by grain**. The decision is recomputed on
the *current* working copy — the user may have edited meanwhile, which can
make a grain conflict that did not when the engine parked. A grain with a
choice is settled at once: it takes the cloud version as its source (the
source hashes are per grain, so the others are untouched) and the engine
stays parked on the grains left undecided, the status listing only those.
Nothing is pushed while one remains, which is why a partially settled state
can never overwrite a cloud grain nobody decided on. The settled grains
survive a restart. Once none is left, the cloud revision becomes `readRev`
and the loop pushes: a cloud that moved once more simply goes through the
same reconciliation (and may park again).

### First write

Providers treat a `null` `baseRev` as an unconditional write. When no file
was known at read time (`readRev === null`), the engine therefore checks
`getRemoteRevision()` first and reconciles instead of writing if a file
appeared meanwhile — another device's first save is never overwritten. The
check is not atomic (a provider-level create-if-absent would be).

The same mechanism covers a **provider switch**: `setProvider()` forgets
`readRev` and the source hashes, so every pending local grain counts as
created here and is merged into what the new provider already holds
(identical grains are fine, different ones with the same id conflict).

## Fast remote-change detection

Target case: moving from PC to phone without thinking of reloading. The
provider owns the *mechanism*, the engine the *scheduling*, the app only
gets events.

- `getRemoteRevision()` exists on every provider (metadata only). The
  optional `watchRemoteChanges()` push channel is **planned** — Dropbox
  would wrap its longpoll; it must be cancellable (`AbortSignal`: hidden
  tab, `disconnect()`, `offline`).
- The engine polls while the tab is **visible** (background timers are
  throttled anyway) plus on `online`/`visibilitychange`. An auth error
  (`invalid_grant` after a revoked grant) surfaces via `lastError`; the app
  should stop syncing rather than hammer a dead session.
- On pull, every grain is decided from the hashes: a grain open in a form
  and untouched here is refreshed (`onData` fires — soft signal: the user
  must not believe they still see the old value); grains edited here are
  kept.

Not retained: Web Push/FCM (requires a push server — breaks the "no data
through our servers" promise), service-worker `periodicsync` (browser-chosen
interval, hours-scale — too coarse).

## Lib / app split

- **Lib (this repo)**: revisioned transport + providers + `SyncEngine`
  (local copy, `readRev`, source hashes, outbox, push loop, grain
  reconciliation, parking, resolution).
- **App**: the `GrainCodec` (business knowledge of what a grain is), the
  conflict-resolution UI (`conflicts` gives both sides of each grain), and
  the Save trigger that calls `save(data)`. The data itself carries no sync
  metadata.

Requirements on the app's data: grains must have **stable ids**, be
JSON-serializable and have equal hashes when equal (the default hasher
ignores key order and what JSON drops).
