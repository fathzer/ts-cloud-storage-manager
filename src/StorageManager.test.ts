/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StorageManager } from "./StorageManager.js";
import { DropboxProvider } from "./providers/DropboxProvider.js";
import { OneDriveProvider } from "./providers/OneDriveProvider.js";

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

const CONFIG = { googleClientId: "google-id", dropboxAppKey: "dropbox-key", oneDriveClientId: "onedrive-id" };

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
    const manager = new StorageManager({ googleClientId: "google-id" });
    expect(manager.availableProviders().map(p => p.name)).toEqual(["gdrive"]);
  });

  it("defaults to Google Drive and remembers a picked provider", () => {
    expect(new StorageManager(CONFIG).currentProvider.constructor.name).toBe("GoogleDriveProvider");
    g.localStorage.setItem(StorageManager.PROVIDER_KEY, "dropbox");
    expect(new StorageManager(CONFIG).currentProvider.constructor.name).toBe("DropboxProvider");
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
});
