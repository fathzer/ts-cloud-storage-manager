# Sync engine — design

The `SyncEngine` adds **offline-first editing** and **multi-device sync** on
top of the revision-aware `StorageProvider` contract. The app keeps a
durable local working copy (IndexedDB — a small database built into the
browser), writes go there first, and the cloud file is a replica synced in
the background.

## Implementation status

**Implemented:**

- Durable local state (`base` snapshot, `baseRev`, working copy, `pending`
  flag) in a pluggable `LocalStore` — `IdbStore` (IndexedDB) by default,
  `MemoryStore` for tests.
- Push loop with optimistic-concurrency retry: write-conflict → download
  remote → merge through the app-supplied `MergePolicy` → push again.
- Conflict **parking** on `UNRECONCILABLE` + three-form resolution
  (`resolveConflict('local' | 'remote' | { merged })`, git-merge style).
- Eager pull — `getRemoteRevision()` on `online`, `visibilitychange` and a
  visible-tab interval (`pollIntervalMs`, 60 s default). Optional
  detect-only mode (`eagerPull: false`): the watchers flag `remoteChanged`
  without merging — drives a "new version available" UX where adoption
  waits for an explicit `pull()`.
- `nextRetryAt` in the status — the scheduled push-retry time when a save
  queued/failed, for "retry at HH:MM" UI. `lastError` also records init
  load failures (so "no remote file" and "load failed" stay distinct).
- Status channel: `pending`, `remoteChanged`, `conflict`, `conflictRemote`
  (the losing remote version, for the resolution UI), `lastError`.
- Offline detection by network failure (the fetch `TypeError`), `'queued'`
  verdict, `reset()` on disconnect.
- **Manager-owned lifecycle** — a `sync` block in `StorageConfig` (or
  `storage.enableSync()`) creates the engine; `StorageManager` then inits
  it on session restore, re-wraps it on provider switches (pending edits
  migrate), pauses it during read-only sessions and purges it on
  `disconnect()`. The whole sync API is reachable on the manager
  (`save(data)`, `onStatus`, `onData`, `resolveConflict`, `pull`) — apps
  never touch the engine directly unless they want to.

**Possible extensions — not implemented:**

- Provider push channels: `watchRemoteChanges(onChange, signal:
  AbortSignal)` — Dropbox `longpoll` wrapped as serverless push
  (needs a cursor from `get_latest_cursor`, honors `backoff`, no
  `Authorization` header, folder-scoped signal → re-check the file rev).
- Multi-tab coordination: `navigator.locks` (one leader tab pushes and
  polls, since the IndexedDB queue is shared) + `BroadcastChannel` to wake
  followers.
- Ready-made grain-merge helpers (per-grain rev markers, tombstone
  bookkeeping — see below). The policy seam already lets an app implement
  all of it.

## How a save flows

1. `save(data)` writes the data into the local store and flags it `pending`
   — **this is the durable point**: after it, a crash or network loss loses
   nothing.
2. The engine pushes with `baseRev` as write guard.
3. Outcomes:
   - **saved** — `base`/`baseRev` advance, `pending` clears.
   - **conflict** (remote moved) — the remote is downloaded and the merge
     policy runs on `{ base, local, remote }`. Reconciled → the merged data
     becomes the working copy (`onData` fires) and is re-pushed — the caller
     only sees `'saved'`. `UNRECONCILABLE` → the engine **parks**: retries
     stop, `conflict` + `conflictRemote` are exposed until `resolveConflict`
     or the next `save()`.
   - **network error** — verdict `'queued'`, a success: the edit waits in
     the outbox and the cycle retries on `online`/`visibilitychange`/poll.
   - **other error** — verdict `'error'`, `lastError` set; pending data is
     kept.
4. `pull()` (eager) does the same merge when the remote revision changed
   while the user was away — so a Save that would conflict is often already
   reconciled (or already parked) before the click.

## Writing a merge policy

The policy is the app's only sync code — it alone knows the data's shape.
**It is optional**: omitted, it defaults to `() => UNRECONCILABLE` — every
divergence parks for user resolution, the conservative whole-file stance.

**Whole-file app** — the file is the single grain:

```ts
const alwaysAsk   = () => UNRECONCILABLE;        // every divergence → user picks
const preferLocal = ({ local })  => local;       // last-write-wins
const preferRemote = ({ remote }) => remote;
```

**Grain-level app** — grains reconcile independently. The proven scheme:
every syncable grain carries the remote `rev` of the last sync it was part
of, persisted *inside* the data (a `rev` field per item). The app tracks
which grains the user touched since then ("dirty"). Per grain:

| local | remote | verdict |
|---|---|---|
| unchanged | `rev == base` | nothing |
| unchanged | `rev != base` | take remote |
| dirty | `rev == base` (unchanged) | keep local (push) |
| dirty | `rev != base` | conflict → `UNRECONCILABLE` (or merge fields) |
| absent | `rev == base` | locally deleted → stay deleted |
| absent (tombstoned) | `rev != base` | delete-vs-edit → conflict |
| absent (no tombstone) | `rev != base` | remotely created → take it |
| present, clean | absent in a moved file | remotely deleted → drop |

**Tombstones are mandatory** for real deletes: `{id, baseRev}` records of
locally deleted grains, kept until the deletion has been pushed — otherwise
"deleted locally" and "created remotely" are indistinguishable and remote
edits would silently resurrect the grain. Non-grain leftovers (profile…)
can simply be one extra grain.

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
- On pull with a **clean** local copy, the remote is adopted wholesale and
  `onData` fires — a grain open in a form gets refreshed (soft signal: the
  user must not believe they still see the old value). With a **dirty**
  copy, the policy decides.

Not retained: Web Push/FCM (requires a push server — breaks the "no data
through our servers" promise), service-worker `periodicsync` (browser-chosen
interval, hours-scale — too coarse).

## Lib / app split

- **Lib (this repo)**: revisioned transport + providers + `SyncEngine`
  (local snapshot, `base`/`baseRev`, outbox, retry loop, parking,
  resolution).
- **App**: the `MergePolicy` (business knowledge of grains + tombstones),
  the conflict-resolution UI (`conflictRemote` gives the remote side), and
  the Save trigger that calls `engine.save(data)`.
