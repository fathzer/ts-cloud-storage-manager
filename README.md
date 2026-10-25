# ts-cloud-storage-manager

A client-side cloud storage manager for single-page applications — no server,
no app secret. Users keep their data file in their own cloud account.

Providers included:

| Provider | Auth flow | Session |
|---|---|---|
| **Dropbox** | redirect OAuth2 + PKCE | long-lived refresh token |
| **OneDrive** | redirect OAuth2 + PKCE (Microsoft Entra "Single-page application" platform) | refresh token, rotated on each refresh |
| **Google Drive** | GIS token client popup | ~1 h token, silent refresh + re-consent dialog |
| **ReadOnlyProvider** | none — fetches JSON from a plain URL | read-only (demo mode) |

## Install

```sh
bun add github:fathzer/ts-cloud-storage-manager
# or once published: bun add ts-cloud-storage-manager
```

No bundler is required: the package ships plain ES modules (`dist/`), so apps
without a bundler can vendor `dist/` and import it with relative paths.

## Usage

```ts
import { StorageManager } from 'ts-cloud-storage-manager';

const storage = new StorageManager({
  dropboxAppKey: '…',        // Dropbox app key (App folder access)
  oneDriveClientId: '…',     // Entra application (client) id
  googleClientId: '…',       // Google OAuth client id
  fileName: 'myapp_data.json',
  driveAppTag: 'myapp',      // appProperties tag identifying the Drive file
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
very first save. Concurrency mechanics per provider:

- **Dropbox** — `files/upload` with `mode: update:<rev>` → 409 `path/conflict`
- **OneDrive** — `if-match: <eTag>` on the content `PUT` → 412
- **Google Drive** — check-then-write on the file `version` (Drive v3 has no
  reliable `If-Match` on media uploads; a small race window remains)

A single token type (`rev`) covers both change detection and the write guard.
On OneDrive it is the item `eTag`, which also changes on pure-metadata edits
(renames): an occasional extra pull, harmless.

## Architecture

```
┌─ App ─────────────────────────────────────────────┐
│  UI · merge policy ({base,local,remote}→merged)    │
├─ SyncEngine (planned) ────────────────────────────┤
│  offline outbox (IndexedDB) · grain merge ·        │
│  tombstones · eager pull · status channel          │
├─ StorageManager ──────────────────────────────────┤
│  provider registry · OAuth return routing          │
├─ StorageProvider ─────────────────────────────────┤
│  auth lifecycle · load()/save(data,baseRev) ·      │
│  getRemoteRevision()                               │
└── Dropbox · OneDrive · Google Drive · ReadOnly ────┘
```

The **providers and the revision-aware contract are implemented**. The
**SyncEngine is the next milestone** — the design is settled (see
`docs/sync-engine.md`): the app supplies a merge policy (it alone knows what a
"syncable grain" is — an asset, a row...), the engine owns the offline queue,
three-way grain reconciliation with tombstones, eager metadata pulls +
explicit push, and a status channel. `getRemoteRevision()` and the conflict
verdicts above are its transport prerequisites — already in place.

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
