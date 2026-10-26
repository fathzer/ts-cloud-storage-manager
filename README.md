# ts-cloud-storage-manager

A client-side cloud storage manager for single-page applications — no server,
no app secret. Users keep their data file in their own cloud account.

A static app (plain HTML + JavaScript, hosted on GitHub Pages for instance)
has no database and no server to store user data in. This library stores the
app's data file **in the user's own cloud account** — Dropbox, OneDrive or
Google Drive — where the user owns it, can see it, and can open the same
file from several devices.

## Features

- **Provider-agnostic data file** — the app reads and writes a single JSON
  file in the user's cloud account behind one `load()` / `save()` contract;
  providers differ only by their OAuth setup.
- **Serverless OAuth2** — PKCE redirect flows (Dropbox, OneDrive) or the
  Google Identity Services token popup (Google Drive): no authorization
  code and no user data ever transits through a server you run. Tokens
  live in `localStorage` and are refreshed lazily — sessions survive page
  reloads.
- **Conflict detection** (optimistic concurrency) — `load()` returns an
  opaque revision token `rev`; `save(data, baseRev)` refuses to overwrite
  a remote file that changed since `baseRev` and reports
  `{ status: 'conflict' }` instead of silently losing edits made on
  another device.
- **Cheap remote-change detection** — `getRemoteRevision()` re-reads the
  file's *metadata only* (no content download): a lightweight primitive
  the app can poll — on `visibilitychange`, on a timer — to learn "the
  file changed elsewhere" before pulling anything.
- **Read-only demo mode** — `ReadOnlyProvider` serves a JSON file from a
  plain URL and silently drops saves.
- **Offline-first sync** — `SyncEngine` keeps a durable local working copy
  (IndexedDB) plus the last-synced base. *Offline-first* means the local
  copy is the one the app reads and writes — no network wait — and the
  cloud is a replica synced in the background: `save()` returns `'saved' |
  'queued' | 'conflict' | 'error'`, pushes when the network returns, merges
  through an app-supplied policy and parks real conflicts for user
  resolution.

| Provider | Auth flow | Session |
|---|---|---|
| **Dropbox** | redirect OAuth2 + PKCE | long-lived refresh token |
| **OneDrive** | redirect OAuth2 + PKCE (Microsoft Entra "Single-page application" platform) | refresh token, rotated on each refresh |
| **Google Drive** | GIS token client popup | ~1 h token, silent refresh + re-consent dialog |
| **ReadOnlyProvider** | none — fetches JSON from a plain URL | read-only (demo mode) |

**Not covered yet** — provider push channels (Dropbox `longpoll`
`watchRemoteChanges`), Web Locks + `BroadcastChannel` multi-tab
coordination and ready-made grain-level merge helpers (per-grain rev
markers, tombstones) are designed in [docs/sync-engine.md](docs/sync-engine.md)
but not implemented. The `SyncEngine` already exists and merges through
the app-supplied policy, so an app can implement grain-level reconciliation
inside its policy today.

## Install

```sh
bun add github:fathzer/ts-cloud-storage-manager
# or once published: bun add ts-cloud-storage-manager
```

No bundler is required: the package ships plain ES modules (`dist/`), so apps
without a bundler can vendor `dist/` and import it with relative paths.

### Stable API — the "kit"

`src/index.ts` re-exports the whole **stable contract** — everything an app
imports is guaranteed semver-stable:

| Export | Role |
|---|---|
| `StorageProvider` + types (`StorageConfig`, `RemoteData`, `SaveResult`, `StorageStatus`, `AuthFailure`, `ConfirmDialogRequest`, `GoogleDriveConfig`) | the provider contract — implement it for a custom backend |
| `StorageManager`, `ProviderName` | provider registry + session facade |
| `ReadOnlyProvider` | the one concrete provider apps instantiate (demo mode, via `useProvider`) |
| `SyncEngine`, `MergePolicy`, `SaveVerdict`, `SyncStatus`, `SyncEngineOptions`, `UNRECONCILABLE` | offline-first sync |
| `LocalStore`, `MemoryStore`, `IdbStore` | sync-state persistence |

Everything else is **internal and free to change**: the OAuth provider
classes (`DropboxProvider`, `OneDriveProvider`, `GoogleDriveProvider` —
instantiated by `StorageManager`, not by apps), `pkce`, `overlayClose`, and
any member prefixed `_`.

## Usage

```ts
import { StorageManager } from 'ts-cloud-storage-manager';

const storage = new StorageManager({
  fileName: 'myapp_data.json',
  dropbox: { appKey: '…' },                // Dropbox app key (App folder access)
  oneDrive: { clientId: '…' },             // Entra application (client) id
  google: {
    clientId: '…',                          // Google OAuth client id
    appTag: 'myapp',                        // appProperties tag on the Drive file
    confirmDialog: (req) => myDialog(req), // optional: localized mid-flow dialogs
  },
  // Optional: a present `sync` block enables the offline-first SyncEngine —
  // the manager then owns its lifecycle (see below).
  sync: {
    policy: ({ base, local, remote }) =>
      mergedData /* …or UNRECONCILABLE when a user decision is needed */,
    // pollIntervalMs: 60_000,             // visible-tab poll, 0 disables
    // eagerPull: false,                   // detect remote changes only —
    //                                     // adoption waits for pull()
    // store: new IdbStore('myapp-sync'),  // IndexedDB by default
  },
});

// On boot: consume a possible OAuth redirect return, then restore the session.
await storage.resumeAuth(new URL(window.location.href));
await storage.initialize();

// Revision-aware access (optimistic concurrency)
const remote = await storage.load();           // { data, rev } | null
const result = await storage.save(data, remote?.rev ?? null);
// result: { status: 'saved', rev: <new rev> } | { status: 'conflict' }

// Cheap change detection (metadata only — for polling/pull-eager designs)
const rev = await storage.getRemoteRevision(); // null = no remote file
```

`save(data, baseRev)` refuses to overwrite a remote file that changed since
`baseRev` (`'conflict'`). `baseRev === null` is an unconditional write, for the
very first save.

Beyond load/save, the manager forwards the session helpers
`authenticate()`, `disconnect()`, `getStatus()` (connected account) and
`getDataLocation()` (human-readable file location for the UI) to the
active provider — which also offers `getAuthFailure()` (classified
login-failure reason: popup blocked, access denied…) and `isReadOnly()`
on `storage.currentProvider`.  
`storage.availableProviders()` lists the providers
whose config block is present; `useProvider()` swaps in any
`StorageProvider` instance (e.g. `ReadOnlyProvider` for a demo session)
and `restoreDefaultProvider()` swaps back.

### Offline sync — `SyncEngine`

With a `sync` config block the whole sync API lives on the manager — the
app never creates an engine itself:

```ts
await storage.initialize();              // inits the engine too
const verdict = await storage.save(data); // 'saved' | 'queued' | 'conflict' | 'error'

storage.onStatus(s => { /* s.pending · s.remoteChanged · s.conflict ·
                           s.conflictRemote · s.nextRetryAt · s.lastError */ });
storage.onData(data => { /* working copy replaced by a merge — re-render */ });
await storage.resolveConflict('local');  // or 'remote', or { merged: data }
await storage.pull();                    // eager remote-change check + merge
```

`save(data)` dispatches to the engine when sync is enabled; the two-arg
`save(data, baseRev)` remains the raw guarded write for non-sync apps.
`storage.syncEngine` exposes the engine instance for engine-specific
calls (`getLocal()`, `reset()`…); `storage.enableSync(policy, options)`
is the lazy equivalent when the config cannot carry the policy at
construction time. The manager owns the plumbing: `initialize()`/
`authenticate()` init the engine once a session exists,
`useProviderByName()`/`useProvider()` re-wrap it around the new provider
(a read-only session only pauses it), and `disconnect()` purges its
state.

`'queued'` is a success: the edit is persisted locally and pushed when the
network returns (`online`, `visibilitychange`, visible-tab polling) —
`status.nextRetryAt` then gives the scheduled retry time for the UI. With
`eagerPull: false` the watchers only *detect* remote moves (`remoteChanged`
flag): adoption/merge waits for an explicit `pull()`, e.g. behind a
"new version available" button.

The merge policy is **invoked inside `save()`** (and inside pulls when
both sides moved): a remote conflict → remote is downloaded →
`policy({base, local, remote})` → reconciled data is re-pushed and the
caller just sees `'saved'`. Only `UNRECONCILABLE` surfaces as `'conflict'`:
the engine then **parks** and reports the losing remote version in the
status (`conflictRemote`) so the resolution UI can show both sides, until
`resolveConflict('local' | 'remote' | {merged})` or the next `save()`. A
whole-file app
can pass a trivial policy; a granular app does its grain reconciliation
inside it. `engine.reset()` purges base + outbox on disconnect.

## How it works

### Concepts in plain words

- **data file** — the whole app data model stored as one JSON file in the
  user's cloud account.
- **`rev` (revision)** — an opaque version marker the provider bumps every
  time the remote file changes. Comparing revs answers "did the file move?";
  sending your base rev with a write asks the provider to *refuse* the write
  if the file moved in the meantime — that is what **conflict detection**
  means here.
- **offline-first** — edits are written locally first (IndexedDB — a small
  database built into every browser), then pushed to the cloud when the
  network allows. No network? Nothing is lost: `'queued'` means "safely
  stored, will sync later".
- **grain** — a piece of data the merge policy can reconcile independently
  of the others (an asset, a row…). A "whole-file" app has exactly one
  grain: the file itself.
- **merge policy** — a function the app hands to the `SyncEngine`:
  `{ base, local, remote } → merged | UNRECONCILABLE`. It is the only place
  that understands the shape of the data — and the only app-specific code
  sync requires.
- **parked** — when the policy cannot reconcile, the engine stops retrying
  and exposes the conflict through its status channel (`conflict` +
  `conflictRemote`) until the app calls `resolveConflict` or saves again.

### The `rev` token

Every provider maps its native file-version field onto one opaque `rev`
string, which serves both as a **write guard** and as a **change marker**:

| Provider | `rev` is… |
|---|---|
| Dropbox | the file `rev` |
| OneDrive | the drive item `eTag` |
| Google Drive | the file `headRevisionId` |
| ReadOnly | the HTTP `ETag` header, when the server sends one |

Once discovered, the file is addressed by its **server-side file id**
(Dropbox `id:`, OneDrive item id, Drive file id): the id survives renames,
so reads, writes and polls keep working when the user renames the data
file. Google Drive additionally tags the file with an `appProperties`
marker to find it again, because the `drive.file` scope only lists files
created by the app and cannot query properties.

### Guarded writes — conflict detection

`baseRev` is translated into the strongest conditional write each API
offers, so a stale writer is rejected server-side whenever possible:

| Provider | Mechanism | Conflict signal |
|---|---|---|
| Dropbox | `files/upload` with `mode: update:<baseRev>` | HTTP 409 `path/conflict` |
| OneDrive | `if-match: <eTag>` header on the content `PUT` | HTTP 412 |
| Google Drive | check-then-write: `headRevisionId` is re-read and compared before the media `PATCH` | rev mismatch → `'conflict'` |
| ReadOnly | saves are dropped anyway | — |

On Google Drive the check and the write are two requests — Drive v3 does
not honor `If-Match` on media uploads — so a small race window remains
(documented, accepted).

### Cheap detection — `getRemoteRevision()`

One metadata request per call; the file content is never transferred:

| Provider | Request | Returns |
|---|---|---|
| Dropbox | `POST /2/files/get_metadata` | the file `rev` |
| OneDrive | `GET /me/drive/items/<id>?$select=id,name,eTag` | the item `eTag` |
| Google Drive | `GET /drive/v3/files/<id>?fields=headRevisionId` | `headRevisionId` |
| ReadOnly | — | `null` (the `ETag` only piggy-backs on `load()`) |

Two quirks worth knowing: OneDrive's `eTag` also changes on pure-metadata
edits — a rename causes an extra pull, harmless — and a dead session
throws instead of returning `null`, so a polling loop can stop on a
revoked grant instead of hammering it.

Polling *scheduling* is deliberately left out of the provider contract:
the `SyncEngine` owns the triggers (`online`, `visibilitychange`,
visible-only intervals — `pollIntervalMs`, 60 s by default); provider push
channels like the Dropbox `longpoll` remain planned.

### Sessions and OAuth returns

Redirect-flow providers (Dropbox, OneDrive) navigate the whole page away —
`authenticate()` never resolves. On the way back,
`StorageManager.resumeAuth(url)` routes the OAuth parameters to the
provider that started the flow (marker in `sessionStorage`, `connect=`
query param on the redirect URI, or a `state` prefix for OneDrive, whose
SPA redirect URIs cannot carry a query string). Refresh tokens give
"connected forever" sessions on Dropbox and OneDrive; Google issues ~1 h
tokens, silently refreshed through GIS and falling back to an injectable
re-consent dialog (`confirmDialog`).

## Architecture

```
┌──────────────────────────── your app ────────────────────────────┐
│  UI · data model · merge policy · conflict-resolution dialog     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ load() · save() · getRemoteRevision()
┌───────────────────────────────▼──────────────────────────────────┐
│  SyncEngine                                                     │
│  offline outbox (IndexedDB) · policy-driven merge ·              │
│  eager pull + explicit push · status channel                     │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│  StorageManager — facade                                         │
│  provider registry · session restore · OAuth-return routing      │
└───────────────────────────────┬──────────────────────────────────┘
                                │
            ┌───────────────────┘
            │  StorageProvider contract — every provider implements:
            │    authenticate() · resumeAuth() · disconnect()
            │    load() → { data, rev }
            │    save(data, baseRev) → saved | conflict
            │    getRemoteRevision() → rev | null
            │
            ├── DropboxProvider      → Dropbox API (OAuth2 redirect + PKCE)
            ├── OneDriveProvider     → Microsoft Graph (OAuth2 redirect + PKCE)
            ├── GoogleDriveProvider  → Drive API v3 (GIS token popup)
            └── ReadOnlyProvider     → any static URL (no auth, demo mode)
```

The `SyncEngine` slots between the app and the provider:
`storage.enableSync(policy)` creates it around the active provider and the
manager owns its lifecycle (init on session restore, re-wrap on provider
switch, pause on read-only, purge on disconnect). The engine itself only
depends on the `StorageProvider` contract — it works unchanged across
providers. The app supplies a merge policy (it alone knows what a
"syncable grain" is — an asset, a row…), the engine owns the offline
queue, reconciliation retries, eager pulls + explicit push, and a status
channel. Not implemented (design in `docs/sync-engine.md`): push-channel
watching and multi-tab coordination.
`ReadOnlyProvider` sits outside the config-driven registry: the app
injects it with `useProvider()` for demo sessions.

## OAuth registration notes

- **Dropbox**: App folder permission; `files.metadata.read` is normally already
  included with `files.content.read` (verify in the app console — it is needed
  for `getRemoteRevision()`). Redirect URIs may carry a query string
  (`https://…/app/?connect=dropbox` is registered verbatim).
- **OneDrive**: Entra platform must be **Single-page application** (required
  for PKCE without a secret); SPA redirect URIs cannot contain a query string —
  the provider name travels inside `state` instead. Delegated scopes:
  `offline_access User.Read Files.ReadWrite.AppFolder`; personal accounts only
  (`consumers` tenant).
- **Google Drive**: GIS token client, `drive.file` scope + email. Redirect URIs
  are the JavaScript origins.

## Test

```sh
bun install
bun test          # unit tests (mocked fetch)
bun run typecheck # tsc --noEmit + test tsconfig
bun run build     # emits dist/ (js + d.ts)
```

## License

Apache-2.0
