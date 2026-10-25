# Sync engine — design

Planned component on top of the revision-aware `StorageProvider` contract.
Goals: **offline-first editing** and **multi-device sync** of a data file made
of independently mutable *grains* (e.g. one asset each), with automatic
reconciliation when disjoint grains diverge and explicit conflict handling
otherwise.

## Building blocks already in place

- `load() → { data, rev } | null` — the file + its remote revision token.
- `save(data, baseRev) → { status:'saved', rev } | { status:'conflict' }` —
  optimistic concurrency (Dropbox `update:<rev>` → 409, OneDrive `if-match` →
  412, Drive check-then-write on `version` — small documented race window).
- `getRemoteRevision()` — metadata-only change detection.

## Grain-level merge (no full base snapshot)

Each syncable grain carries the file `rev` of the last sync it was part of,
persisted *inside* the data (a `rev` field per item). Mutations go through the
engine (`touch(id)` or declared `dirtyIds` — API still open), which marks the
grain dirty while keeping its last-synced rev.

At sync time, per grain:

| local | remote | verdict |
|---|---|---|
| unchanged | `rev == base` | nothing |
| unchanged | `rev != base` | take remote |
| dirty | `rev == base` (unchanged) | push local |
| dirty | `rev != base` | conflict |
| absent | `rev == base` | locally deleted → stay deleted |
| absent (tombstoned) | `rev != base` | delete-vs-edit → conflict |
| absent (no tombstone) | `rev != base` | remotely created → take it |
| present, clean | absent in a moved file | remotely deleted → drop |

**Tombstones are mandatory**: `{id, baseRev}` records of locally deleted
grains, kept in local state (not in the file) until the deletion has been
pushed successfully — otherwise "deleted locally" and "created remotely" are
indistinguishable and remote edits would silently resurrect the grain.

Non-grain data (profile…) follows the same rule: every syncable unit carries
its `rev`; the remainder of the file can be one extra grain.

## Orchestration: eager pull + explicit push

- **Eager pull**: in the background the engine reads metadata (cheap) and
  notifies the app when `remote != base`; the merge can be pre-computed before
  the next Save — the conflict is already known when the user clicks.
- **Explicit push** on the user's Save action, verdict
  `saved | queued | conflict | error`; `queued` is a *success* (data is durable
  locally), not a failure.
- The auto loop **parks** on a true conflict (state exposed, retries stopped —
  no ping-pong); resolution via the UI.
- **Status channel** (`pending` count + last error): queued saves resolve
  later, the UI watches the queue drain.
- **Offline detection**: the API call's network failure is the truth
  (`navigator.onLine` lies — captive portals); retry on `online`,
  `visibilitychange`, backoff.
- Local persistence in **IndexedDB** (outbox + data), not `localStorage`.
- `disconnect()` / account switch purges base + outbox.

### Fast remote-change detection

Target case: moving from PC to phone without thinking of reloading. The
provider owns the *mechanism*, the SyncEngine the *scheduling*, the app only
gets events.

- `StorageProvider`: `getRemoteRevision()` everywhere; optional
  `watchRemoteChanges(onChange, signal: AbortSignal)` for serverless push —
  Dropbox would wrap its longpoll (pending connection, timeout, re-arm =
  internals). Cancellable: stopped on hidden tab, `disconnect()`, `offline`.
- `SyncEngine`: prefers `watchRemoteChanges()` when available, else polls
  `getRemoteRevision()`; compares to `baseRev`, triggers pull+merge. An auth
  error (`invalid_grant` after revocation) **stops detection** and surfaces
  via the status channel — no retry.
- Triggers, by ROI: `visibilitychange`/`focus` check (the phone keeps the app
  in background — kills the "forgot to reload" case); ~30-60 s polling **only
  while the tab is visible** (background timers are throttled anyway);
  optional Dropbox longpoll (`files/list_folder/longpoll` — needs a cursor
  from `get_latest_cursor`, honors `backoff`, no `Authorization` header,
  folder-scoped signal → re-check the file rev); `BroadcastChannel` + Web
  Locks for multi-tab on one device — a single leader tab (`navigator.locks`)
  pushes and polls, since the IndexedDB queue is shared.
- On pull: grain merge applied immediately. Conflict only when a **locally
  dirty** grain also moved remotely → park + soft signal. A clean grain open
  in a form is refreshed (soft signal — the user must not believe they still
  see the old value); other grains update the UI via a "data refreshed" event.

Not retained: Web Push/FCM (requires a push server — breaks the "no data
through our servers" promise), service-worker `periodicsync` (browser-chosen
interval, hours-scale — too coarse).

## Lib / app split

- **Lib**: revisioned transport + `SyncEngine` (local snapshot,
  `base`/`baseRev`, outbox, retry loop, tombstones) + providers.
- **App**: merge policy `{ base, local, remote } → merged | 'unreconcilable'`
  (business knowledge of grains), conflict UI, Save trigger.
