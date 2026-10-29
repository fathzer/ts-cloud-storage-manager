/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StorageManager } from "./StorageManager.js";
import { DropboxProvider } from "./providers/DropboxProvider.js";
import { OneDriveProvider } from "./providers/OneDriveProvider.js";
import { ReadOnlyProvider } from "./providers/ReadOnlyProvider.js";
import { MemoryStore } from "./sync/LocalStore.js";
import { UNRECONCILABLE } from "./sync/SyncEngine.js";

// Bun has no DOM storage: install minimal in-memory shims before the
// providers (which read localStorage in their constructor) are built.
class FakeStorage {
  _map = new Map<string, string>();
  getItem(k: string) { return this._map.get(k) ?? null; }
  setItem(k: string, v: string) { this._map.set(k, String(v)); }
  removeItem(k: string) { this._map.delete(k); }
  clear() { this._map.clear(); }
}

const g = globalThis as unknown as { localStorage: FakeStorage; sessionStorage: FakeStorage; fetch: typeof fetch };
const realFetch = globalThis.fetch;

const CONFIG = {
  google: { clientId: "google-id" },
  dropbox: { appKey: "dropbox-key" },
  oneDrive: { clientId: "onedrive-id" }
};

beforeEach(() => {
  g.localStorage = new FakeStorage();
  g.sessionStorage = new FakeStorage();
});

afterEach(() => {
  g.fetch = realFetch;
});

describe("StorageManager providers", () => {
  it("lists every configured provider", () => {
    const manager = new StorageManager(CONFIG);
    expect(manager.availableProviders().map(p => p.name)).toEqual(["dropbox", "onedrive", "gdrive"]);
  });

  it("hides providers missing their credentials", () => {
    const manager = new StorageManager({ google: { clientId: "google-id" } });
    expect(manager.availableProviders().map(p => p.name)).toEqual(["gdrive"]);
  });

  it("defaults to Google Drive and remembers a picked provider", () => {
    expect(new StorageManager(CONFIG).currentProvider.constructor.name).toBe("GoogleDriveProvider");
    g.localStorage.setItem(StorageManager.PROVIDER_KEY, "dropbox");
    expect(new StorageManager(CONFIG).currentProvider.constructor.name).toBe("DropboxProvider");
  });

  it("defaults to a configured provider when Google is absent", () => {
    // Bug repro: _rememberedName falls back to 'gdrive', whose config block
    // is missing → construction crashes for Dropbox/OneDrive-only apps.
    const manager = new StorageManager({ dropbox: { appKey: "k" }, oneDrive: { clientId: "id" } });
    expect(manager.providerName).toBe("dropbox");
  });
});

describe("StorageManager.resumeAuth", () => {
  it("returns 'none' when the URL carries no OAuth parameter", async () => {
    const manager = new StorageManager(CONFIG);
    expect(await manager.resumeAuth(new URL("https://example.com/app/?connect"))).toBe("none");
  });

  it("routes the return URL to the pending redirect provider", async () => {
    g.sessionStorage.setItem(StorageManager.PENDING_KEY, "dropbox");
    const manager = new StorageManager(CONFIG);
    // No stored dbx_state: the Dropbox provider rejects with a state mismatch.
    const verdict = await manager.resumeAuth(new URL("https://example.com/app/?code=c&state=s"));
    expect(verdict).toBe(false);
    expect(manager.currentProvider).toBeInstanceOf(DropboxProvider);
    expect(manager.currentProvider.getAuthFailure()?.kind).toBe("error");
    expect(g.sessionStorage.getItem(StorageManager.PENDING_KEY)).toBeNull();
  });

  it("falls back on the connect=<name> value when no pending marker exists", async () => {
    const manager = new StorageManager(CONFIG);
    const verdict = await manager.resumeAuth(new URL("https://example.com/app/?connect=dropbox&code=c&state=s"));
    expect(verdict).toBe(false);
    expect(manager.currentProvider).toBeInstanceOf(DropboxProvider);
  });

  it("falls back on the provider prefix in state when neither marker nor connect exists", async () => {
    // OneDrive's bare redirect URI carries no connect param; the provider
    // name is prefixed inside the state instead.
    const manager = new StorageManager(CONFIG);
    const verdict = await manager.resumeAuth(new URL("https://example.com/app/?code=c&state=onedrive:s"));
    expect(verdict).toBe(false);
    expect(manager.currentProvider).toBeInstanceOf(OneDriveProvider);
  });

  it("ignores a connect=<name> hint naming an unconfigured provider", async () => {
    // Bug repro: a ?connect=gdrive deep link on a Dropbox/OneDrive-only app
    // crashed the boot — resumeAuth switched to the hinted provider without
    // checking its config block exists.
    const manager = new StorageManager({ dropbox: { appKey: "k" }, oneDrive: { clientId: "id" } });
    expect(await manager.resumeAuth(new URL("https://example.com/app/?connect=gdrive"))).toBe("none");
    expect(manager.providerName).toBe("dropbox");
  });

  it("ignores a state prefix naming an unconfigured provider", async () => {
    const manager = new StorageManager({ dropbox: { appKey: "k" } });
    // state=onedrive:… cannot route to OneDrive without its config block;
    // the error param is consumed by the active provider instead.
    const verdict = await manager.resumeAuth(new URL("https://example.com/app/?error=access_denied&state=onedrive:s"));
    expect(verdict).toBe(false);
    expect(manager.providerName).toBe("dropbox");
  });
});

describe("StorageManager sync lifecycle", () => {
  it("enables sync from a bare config.sync block (default always-park policy)", () => {
    const manager = new StorageManager({ ...CONFIG, sync: {} });
    const engine = manager.syncEngine;
    expect(engine).not.toBeNull();
    // Default policy: every divergence is unreconcilable.
    expect(engine!.policy({ base: 1, local: 1, remote: 2 })).toBe(UNRECONCILABLE);
  });


  it("create an engine around the active provider via enableSync", () => {
    const manager = new StorageManager(CONFIG);
    const engine = manager.enableSync(() => UNRECONCILABLE, { store: new MemoryStore() });
    expect(manager.syncEngine).toBe(engine);
    expect(engine.provider).toBe(manager.currentProvider);
    // Idempotent: same instance on a second call.
    expect(manager.enableSync(() => UNRECONCILABLE)).toBe(engine);
  });

  it("re-wraps the engine on provider switch, pauses on read-only", async () => {
    const manager = new StorageManager(CONFIG);
    const engine = manager.enableSync(() => UNRECONCILABLE, { store: new MemoryStore() });
    manager.useProviderByName("dropbox");
    expect(engine.provider).toBe(manager.currentProvider); // re-wrapped
    const readOnly = new ReadOnlyProvider("https://example.com/demo.json");
    manager.useProvider(readOnly);                          // demo session
    expect(engine.provider).not.toBe(readOnly);             // paused, not re-wrapped
  });

  it("purges the engine state on disconnect", async () => {
    const manager = new StorageManager(CONFIG);
    const engine = manager.enableSync(() => UNRECONCILABLE, { store: new MemoryStore(), pollIntervalMs: 0 });
    await engine.save({ v: 1 });                            // offline under Bun → queued/pending
    expect(engine.getLocal()).toEqual({ v: 1 });
    await manager.disconnect();
    expect(engine.getLocal()).toBeNull();
    expect(engine.baseRev).toBeNull();
  });
});
