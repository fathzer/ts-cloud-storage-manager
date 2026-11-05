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
- **Same-origin isolation** — a required `namespace` prefixes every key the
  library persists (localStorage sessions, sessionStorage OAuth markers,
  the sync IndexedDB database), so sibling apps sharing an origin — two
  project pages on `*.github.io`, two dev servers on the same localhost
  port — can never read or overwrite each other's state as long their namespaces are different.
- **Read-only demo mode** — `ReadOnlyProvider` serves a JSON file from a
  plain URL and silently drops saves.
- **Offline-first sync** — `SyncEngine` keeps a durable local working copy
  (IndexedDB) plus, per grain, a hash of the cloud version it was read from.
  *Offline-first* means the local copy is the one the app reads and writes —
  no network wait — and the cloud is a replica synced in the background:
  `save()` returns `'saved' | 'queued' | 'conflict' | 'error'`, pushes when
  the network returns, merges grain by grain (an app only says how its file
  splits into grains) and parks the grains edited differently on both sides
  for user resolution.

| Provider | Auth flow | Session |
|---|---|---|
| **Dropbox** | redirect OAuth2 + PKCE | long-lived refresh token |
| **OneDrive** | redirect OAuth2 + PKCE (Microsoft Entra "Single-page application" platform) | refresh token, rotated on each refresh |
| **Google Drive** | GIS token client popup | ~1 h token, silent refresh + re-consent dialog |
| **ReadOnlyProvider** | none — fetches JSON from a plain URL | read-only (demo mode) |

**Not covered yet** — provider push channels (Dropbox `longpoll`
`watchRemoteChanges`) and Web Locks + `BroadcastChannel` multi-tab
coordination are designed in [docs/sync-engine.md](docs/sync-engine.md)
but not implemented.

## Install

```sh
# Pin a release tag — recommended:
bun add github:fathzer/ts-cloud-storage-manager#v0.0.1-preview
# or once published on npm: bun add ts-cloud-storage-manager
```

With a `github:` dependency, the **available versions are the repo's git
tags** — browse them on the
[releases page](https://github.com/fathzer/ts-cloud-storage-manager/releases)
or list them with
`git ls-remote --tags https://github.com/fathzer/ts-cloud-storage-manager`.
Pin a tag (`#v0.0.1-preview`) for production; a branch (`#main`) or a
commit sha also works, but a branch silently tracks every push.

The `dist/` build output is not committed, so installation runs the
package's `prepare` script (`tsc`). If your package manager blocks
dependency lifecycle scripts, whitelist it (e.g. bun:
`"trustedDependencies": ["ts-cloud-storage-manager"]`).

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
| `SyncEngine`, `SaveVerdict`, `SyncStatus`, `SyncEngineOptions`, `ConflictInfo`, `ConflictChoice`, `Resolution` | offline-first sync |
| `GrainCodec`, `GrainId`, `GrainHasher`, `WHOLE_FILE_GRAIN` | how an app cuts its file into grains |
| `LocalStore`, `MemoryStore`, `IdbStore` | sync-state persistence |

Everything else is **internal and free to change**: the OAuth provider
classes (`DropboxProvider`, `OneDriveProvider`, `GoogleDriveProvider` —
instantiated by `StorageManager`, not by apps), `pkce`, `overlayClose`, and
any member prefixed `_`.

## Usage

```ts
import { StorageManager } from 'ts-cloud-storage-manager';

const storage = new StorageManager({
  namespace: 'myapp',                      // required — see "Storage namespace"
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
    // How the file splits into grains — the independently reconcilable
    // pieces. Omitted: the whole file is one grain (any divergence parks).
    grains: {
      split: (data) => new Map(data.items.map(i => [i.id, i])),
      join: (grains) => ({ items: [...grains.values()] }),
    },
    // hash: (grain) => '…',               // default: SHA-256 of canonical JSON
    // pollIntervalMs: 60_000,             // visible-tab poll, 0 disables
    // eagerPull: false,                   // detect remote changes only —
    //                                     // adoption waits for pull()
    // store: new IdbStore('myapp-sync'),  // IndexedDB '<ns>.cloud-sync'
    //                                     // by default
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
                           s.conflicts · s.nextRetryAt · s.lastError */ });
storage.onData(data => { /* working copy replaced by a merge — re-render */ });
await storage.resolveConflict('local');  // or 'remote' for every conflicting
                                         // grain, or one choice per grain id:
await storage.resolveConflict({ car1: 'local', car2: 'remote', car3: { merged: grain } });
await storage.pull();                    // eager remote-change check + merge
```

`save(data)` dispatches to the engine when sync is enabled; the two-arg
`save(data, baseRev)` remains the raw guarded write for non-sync apps.
`storage.syncEngine` exposes the engine instance for engine-specific
calls (`getLocal()`, `reset()`…); `storage.enableSync(options)`
is the lazy equivalent when the config cannot carry the options at
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

The reconciliation runs **inside `save()`** (and inside pulls when the
cloud moved): a refused write → the cloud file is downloaded → each grain
is decided from content hashes alone (edited here only → kept and pushed;
edited in the cloud only → taken; same edit on both sides → nothing to do)
→ the merged copy is re-pushed and the caller just sees `'saved'`. Only a
grain **edited differently on both sides** surfaces as `'conflict'`: the
engine then **parks** and reports both versions of each conflicting grain
in the status (`conflicts`), until `resolveConflict(…)`. Edits made while
parked stay local and are not pushed. No grain codec needed for a
whole-file app — the file is then the only grain. `engine.reset()` purges
the local state on disconnect.

## Storage namespace

Browser storage is scoped by **origin** (scheme + host + port) — never by
path. Two apps served under `https://me.github.io/app-a` and
`https://me.github.io/app-b`, or two dev servers taking turns on
`localhost:5500`, share one localStorage, one sessionStorage and one
IndexedDB. Without isolation they would hijack each other: an app can
pick up — then destroy — another app's session (a refresh token is only
valid for the OAuth client that issued it), read and overwrite the other
app's cloud file through a cached file id, or push foreign data into its
own remote file through a shared sync outbox.

`StorageConfig.namespace` is therefore **required** and prefixes
everything the library persists:

| Store | Keys |
|---|---|
| localStorage | `<ns>.provider`, `<ns>.dbx_*`, `<ns>.od_*`, `<ns>.gdrive_*` |
| sessionStorage | `<ns>.pending_provider`, `<ns>.dbx_state` / `dbx_verifier` / `dbx_redirect_uri`, `<ns>.od_state` / `od_verifier` / `od_redirect_uri` |
| IndexedDB | database `<ns>.cloud-sync` (store `state`) |

Pick one short, stable, unique string per deployed application
(`'myapp'`). Two unrelated apps must never share a namespace. Changing it
later orphans the previous data exactly like a fresh install: users
reconnect, and local edits not yet pushed are left behind in the old
namespace.

> **Migration from pre-namespace versions** — earlier releases wrote
> unprefixed keys (`mp_provider`, `dbx_*`, `od_*`, `gdrive_*`) and the
> `cloud-sync` database. Those entries are now ignored: existing users
> reconnect once, and edits still queued in the old database are not
> migrated. Delete them manually if you want a clean devtools view.

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
- **grain** — a piece of data that is reconciled independently of the
  others (an asset, a row…). A "whole-file" app has exactly one grain: the
  file itself.
- **grain codec** — `{ split, join }`, the two functions an app hands to the
  `SyncEngine` to cut its file into grains and rebuild it. It is the only
  place that understands the shape of the data — and the only app-specific
  code sync requires.
- **source hashes** — per grain, the hash of the cloud version the local
  copy was last read from or pushed to. They tell a local edit from a
  remote one without ever keeping a copy of the source data.
- **parked** — when a grain was edited differently on both sides, the
  engine stops pushing and exposes the conflicting grains through its
  status channel (`conflict` + `conflicts`) until the app calls
  `resolveConflict`.

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
│  UI · data model · grain codec · conflict-resolution dialog      │
└───────────────────────────────┬──────────────────────────────────┘
                                │ load() · save() · getRemoteRevision()
┌───────────────────────────────▼──────────────────────────────────┐
│  SyncEngine                                                     │
│  offline outbox (IndexedDB) · hash-based grain merge ·           │
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
`storage.enableSync(options)` creates it around the active provider and the
manager owns its lifecycle (init on session restore, re-wrap on provider
switch, pause on read-only, purge on disconnect). The engine itself only
depends on the `StorageProvider` contract — it works unchanged across
providers. The app supplies a grain codec (it alone knows what a
"syncable grain" is — an asset, a row…), the engine owns the offline
queue, the hash-based reconciliation, eager pulls + explicit push, and a
status channel. Not implemented (design in `docs/sync-engine.md`): push-channel
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

**Not supported: pCloud** — a full provider was implemented and then
removed: pCloud offers no browser-usable way to *download* file content.

The OAuth side works fine (implicit grant — the code flow needs the client
secret, unusable in a SPA; the fragment even reports the account's US/EU
zone host). Uploads (`uploadfile`), metadata (`stat`) and `userinfo` all
answer correctly on `api.pcloud.com`/`eapi.pcloud.com` with open CORS.
But every documented read path is closed to web applications:

- `getfilelink` rejects requests whose referer is not `pcloud.com`
  (result 7010 "Invalid link referer") — the check also covers `Origin`,
  which the browser always sends on CORS requests and which cannot be
  removed (`referrerPolicy: 'no-referrer'` does not help);
- the `fileops` family (`file_open`/`file_read`), which would read content
  straight on the API host, answers 2003 "Access denied" under OAuth2
  tokens — it is reserved for pCloud's own clients;
- generated download links live on file hosts without open CORS (and are
  bound to the requesting IP anyway).

pCloud staff confirmed in
[pcloud-sdk-js#4](https://github.com/pCloud/pcloud-sdk-js/issues/4) that
downloading from web applications is not supported — the issue has been
open since 2017 with an unchanged API. Worth revisiting only if pCloud
opens one of these paths (PKCE + CORS-enabled downloads, or OAuth2-enabled
fileops).

## Test

```sh
bun install
bun test          # unit tests (mocked fetch)
bun run typecheck # tsc --noEmit + test tsconfig
bun run build     # emits dist/ (js + d.ts)
```

## Releasing — for maintainers

Releases are cut with **`npm version`**, which bumps `package.json`,
commits the bump and creates the tag in one atomic step — the version and
its tag can never diverge by accident. Never edit `version` by hand and
never create release tags manually.

```sh
# On the release branch, with a clean tree:
npm version 0.0.1-preview        # → commit "0.0.1-preview" + tag v0.0.1-preview
npm version patch                # → 0.0.2 + tag v0.0.2 (later releases)
git push --follow-tags origin <branch>
```

Then:

1. Open the PR to `main` and merge it **with a merge commit** (or let it
   fast-forward). A squash/rebase merge leaves the tag pointing at an
   orphan commit outside `main` — it still resolves, but the released
   code is no longer what the tag names.
2. Create the GitHub release on the existing tag (`v0.0.1-preview`) and
   tick **pre-release** for `-preview` / `-alpha` / `-rc` versions.

Consumers pin a tag
(`github:fathzer/ts-cloud-storage-manager#v0.0.1-preview`), so the tag
must be pushed before they can install. `npm version` prefixes tags with
`v` by default — keep that prefix in dependency specs.

### Safety net — `check-tag.yml`

`.github/workflows/check-tag.yml` runs on every `v*` tag push, compares
the tag (minus `v`) to `package.json#version`, and on a mismatch **fails
the run and deletes the tag from GitHub** — a hand-made inconsistent tag
cannot survive long enough to be pinned by an app. Deletion only touches
the remote ref; clones that already fetched the tag keep it locally until
they fetch again.

## License

Apache-2.0
