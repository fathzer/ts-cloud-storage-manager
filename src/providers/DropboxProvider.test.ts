/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DropboxProvider } from "./DropboxProvider.js";

// Bun has no DOM storage: install minimal in-memory shims before the
// provider (which reads localStorage in its constructor) is built.
class FakeStorage {
  _map = new Map<string, string>();
  getItem(k: string) { return this._map.get(k) ?? null; }
  setItem(k: string, v: string) { this._map.set(k, String(v)); }
  removeItem(k: string) { this._map.delete(k); }
  clear() { this._map.clear(); }
}

const g = globalThis as unknown as { localStorage: FakeStorage; sessionStorage: FakeStorage; fetch: typeof fetch };
const realFetch = globalThis.fetch;

interface RecordedCall { url: string; init?: RequestInit }
let calls: RecordedCall[] = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  g.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: u, init });
    return handler(u, init);
  }) as typeof fetch;
}

/** The Dropbox-API-Arg header of an upload/download call, parsed. */
function apiArg(init?: RequestInit): Record<string, unknown> {
  const headers = init?.headers as Record<string, string> | undefined;
  return JSON.parse(String(headers?.["Dropbox-API-Arg"]));
}

/** A logged-in provider (tokens pre-stored, access token still valid). */
function loggedInProvider(): DropboxProvider {
  g.localStorage!.setItem("dbx_refresh", "r");
  g.localStorage!.setItem("dbx_access", "a");
  g.localStorage!.setItem("dbx_expires", String(Date.now() + 3600_000));
  return new DropboxProvider(APP_KEY);
}

beforeEach(() => {
  g.localStorage = new FakeStorage();
  g.sessionStorage = new FakeStorage();
});

afterEach(() => {
  g.fetch = realFetch;
});

const APP_KEY = "test-app-key";

describe("DropboxProvider.resumeAuth", () => {
  it("returns 'none' when the URL carries no OAuth parameter", async () => {
    const provider = new DropboxProvider(APP_KEY);
    expect(await provider.resumeAuth(new URL("https://example.com/app/"))).toBe("none");
  });

  it("maps error=access_denied to the accessDenied failure", async () => {
    const provider = new DropboxProvider(APP_KEY);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?error=access_denied&state=abc"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("accessDenied");
  });

  it("maps other errors to 'error' with the provider description as detail", async () => {
    const provider = new DropboxProvider(APP_KEY);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?error=temporarily_unavailable&error_description=try+later"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
    expect(provider.getAuthFailure()?.detail).toBe("try later");
  });

  it("rejects a code whose state does not match the stored one", async () => {
    g.sessionStorage!.setItem("dbx_state", "expected-state");
    g.sessionStorage!.setItem("dbx_verifier", "verifier");
    g.sessionStorage!.setItem("dbx_redirect_uri", "https://example.com/app/?connect=dropbox");
    const provider = new DropboxProvider(APP_KEY);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?connect=dropbox&code=abc&state=other"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
  });

  it("exchanges the code, stores tokens and clears the pending request", async () => {
    g.sessionStorage!.setItem("dbx_state", "the-state");
    g.sessionStorage!.setItem("dbx_verifier", "the-verifier");
    g.sessionStorage!.setItem("dbx_redirect_uri", "https://example.com/app/?connect=dropbox");
    mockFetch((url) => {
      if (url === DropboxProvider.TOKEN_URL) {
        return new Response(JSON.stringify({
          access_token: "access-1", refresh_token: "refresh-1", expires_in: 14400
        }), { status: 200 });
      }
      if (url === `${DropboxProvider.API_URL}/users/get_current_account`) {
        return new Response(JSON.stringify({ email: "user@example.com" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new DropboxProvider(APP_KEY);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?code=the-code&state=the-state"));
    expect(ok).toBe(true);
    expect(provider.getAuthFailure()).toBeNull();
    expect(provider.accessToken).toBe("access-1");
    expect(provider.refreshToken).toBe("refresh-1");
    expect(provider.userEmail).toBe("user@example.com");
    expect(g.localStorage!.getItem("dbx_refresh")).toBe("refresh-1");
    expect(g.sessionStorage!.getItem("dbx_state")).toBeNull();

    // The exchange used PKCE (verifier, not a secret) and the stored redirect URI.
    const body = String(calls[0].init?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=the-verifier");
    expect(body).toContain(`client_id=${APP_KEY}`);
    expect(body).not.toContain("client_secret");
  });

  it("fails the auth when the token exchange fails", async () => {
    g.sessionStorage!.setItem("dbx_state", "s");
    g.sessionStorage!.setItem("dbx_verifier", "v");
    g.sessionStorage!.setItem("dbx_redirect_uri", "https://example.com/app/?connect=dropbox");
    mockFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const provider = new DropboxProvider(APP_KEY);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?code=c&state=s"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
    expect(provider.refreshToken).toBeNull();
  });
});

describe("DropboxProvider session", () => {
  it("init() reports a session only when a refresh token is stored", async () => {
    expect(await new DropboxProvider(APP_KEY).init()).toBe(false);
    g.localStorage!.setItem("dbx_access", "a");
    expect(await new DropboxProvider(APP_KEY).init()).toBe(false);
    g.localStorage!.setItem("dbx_refresh", "r");
    expect(await new DropboxProvider(APP_KEY).init()).toBe(true);
  });

  it("refreshes an expired access token lazily on the first API call", async () => {
    g.localStorage!.setItem("dbx_refresh", "refresh-1");
    g.localStorage!.setItem("dbx_access", "old-token");
    g.localStorage!.setItem("dbx_expires", "1"); // long expired
    mockFetch((url) => {
      if (url === DropboxProvider.TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 14400 }), { status: 200 });
      }
      if (url === `${DropboxProvider.CONTENT_URL}/files/download`) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ id: "id:file-1", name: "data.json", rev: "rev-1" }) }
        });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new DropboxProvider(APP_KEY);
    const remote = await provider.load();
    expect(remote?.data).toEqual({ items: [] });
    expect(remote?.rev).toBe("rev-1");
    expect(provider.accessToken).toBe("fresh-token");
    expect(provider.fileId).toBe("id:file-1");
    // The file id is reused verbatim as the path on the next calls (survives renames).
    expect(provider._filePath()).toBe("id:file-1");
  });

  it("returns null when the data file does not exist", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { path: { ".tag": "not_found" } } }), { status: 409 }));
    const provider = loggedInProvider();
    expect(await provider.load()).toBeNull();
  });

  it("disconnect() clears every stored credential", async () => {
    g.localStorage!.setItem("dbx_refresh", "r");
    g.localStorage!.setItem("dbx_access", "a");
    g.localStorage!.setItem("dbx_user_email", "u@e.com");
    mockFetch(() => new Response("", { status: 200 }));
    const provider = new DropboxProvider(APP_KEY);
    await provider.disconnect();
    expect(g.localStorage!.getItem("dbx_refresh")).toBeNull();
    expect(g.localStorage!.getItem("dbx_access")).toBeNull();
    expect(g.localStorage!.getItem("dbx_user_email")).toBeNull();
    expect((await provider.getStatus()).isConnected).toBe(false);
  });
});

describe("DropboxProvider data", () => {
  it("saves by file id once known, by name otherwise", async () => {
    const paths: string[] = [];
    mockFetch((url, init) => {
      if (url === `${DropboxProvider.CONTENT_URL}/files/upload`) {
        const arg = apiArg(init);
        paths.push(String(arg.path));
        return new Response(JSON.stringify({ id: "id:new-file", name: "data.json", rev: "rev-new" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.save({ items: [] }, null)).toEqual({ status: "saved", rev: "rev-new" });
    expect(paths).toEqual(["/data.json"]);
    expect(provider.fileId).toBe("id:new-file");
    expect(await provider.save({ items: [] }, "rev-new")).toEqual({ status: "saved", rev: "rev-new" });
    expect(paths).toEqual(["/data.json", "id:new-file"]);
  });

  it("writes with mode update:<baseRev> when a base revision is given", async () => {
    let mode: unknown;
    mockFetch((url, init) => {
      if (url === `${DropboxProvider.CONTENT_URL}/files/upload`) {
        mode = apiArg(init).mode;
        return new Response(JSON.stringify({ id: "id:f", name: "data.json", rev: "rev-2" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    await provider.save({ items: [] }, "rev-1");
    expect(mode).toEqual({ ".tag": "update", update: "rev-1" });
  });

  it("reports 'conflict' when the remote revision changed", async () => {
    mockFetch((url) => {
      if (url === `${DropboxProvider.CONTENT_URL}/files/upload`) {
        return new Response(JSON.stringify({ error: { ".tag": "path", path: { ".tag": "conflict" } } }), { status: 409 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.save({ items: [] }, "rev-1")).toEqual({ status: "conflict" });
  });

  it("getRemoteRevision reads the file metadata rev", async () => {
    mockFetch((url) => {
      if (url === `${DropboxProvider.API_URL}/files/get_metadata`) {
        return new Response(JSON.stringify({ id: "id:file-1", name: "data.json", rev: "rev-7" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.getRemoteRevision()).toBe("rev-7");
    expect(provider.fileId).toBe("id:file-1");
  });

  it("getRemoteRevision returns null when the file does not exist", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { path: { ".tag": "not_found" } } }), { status: 409 }));
    const provider = loggedInProvider();
    expect(await provider.getRemoteRevision()).toBeNull();
  });
});
