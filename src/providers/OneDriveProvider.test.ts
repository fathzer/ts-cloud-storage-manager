/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OneDriveProvider } from "./OneDriveProvider.js";

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

/** A logged-in provider (tokens pre-stored, access token still valid). */
function loggedInProvider(): OneDriveProvider {
  g.localStorage!.setItem("od_refresh", "r");
  g.localStorage!.setItem("od_access", "a");
  g.localStorage!.setItem("od_expires", String(Date.now() + 3600_000));
  return new OneDriveProvider(CLIENT_ID);
}

beforeEach(() => {
  g.localStorage = new FakeStorage();
  g.sessionStorage = new FakeStorage();
});

afterEach(() => {
  g.fetch = realFetch;
});

const CLIENT_ID = "test-client-id";
const GRAPH = OneDriveProvider.GRAPH_URL;

describe("OneDriveProvider.resumeAuth", () => {
  it("returns 'none' when the URL carries no OAuth parameter", async () => {
    const provider = new OneDriveProvider(CLIENT_ID);
    expect(await provider.resumeAuth(new URL("https://example.com/app/"))).toBe("none");
  });

  it("maps error=access_denied to the accessDenied failure", async () => {
    const provider = new OneDriveProvider(CLIENT_ID);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?error=access_denied&state=abc"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("accessDenied");
  });

  it("maps other errors to 'error' with the provider description as detail", async () => {
    const provider = new OneDriveProvider(CLIENT_ID);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?error=temporarily_unavailable&error_description=try+later"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
    expect(provider.getAuthFailure()?.detail).toBe("try later");
  });

  it("rejects a code whose state does not match the stored one", async () => {
    g.sessionStorage!.setItem("od_state", "expected-state");
    g.sessionStorage!.setItem("od_verifier", "verifier");
    g.sessionStorage!.setItem("od_redirect_uri", "https://example.com/app/");
    const provider = new OneDriveProvider(CLIENT_ID);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?code=abc&state=other"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
  });

  it("exchanges the code, stores tokens and clears the pending request", async () => {
    g.sessionStorage!.setItem("od_state", "the-state");
    g.sessionStorage!.setItem("od_verifier", "the-verifier");
    g.sessionStorage!.setItem("od_redirect_uri", "https://example.com/app/");
    mockFetch((url) => {
      if (url === OneDriveProvider.TOKEN_URL) {
        return new Response(JSON.stringify({
          access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600
        }), { status: 200 });
      }
      if (url === `${GRAPH}/me`) {
        return new Response(JSON.stringify({ userPrincipalName: "user@example.com" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new OneDriveProvider(CLIENT_ID);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?code=the-code&state=the-state"));
    expect(ok).toBe(true);
    expect(provider.getAuthFailure()).toBeNull();
    expect(provider.accessToken).toBe("access-1");
    expect(provider.refreshToken).toBe("refresh-1");
    expect(provider.userEmail).toBe("user@example.com");
    expect(g.localStorage!.getItem("od_refresh")).toBe("refresh-1");
    expect(g.sessionStorage!.getItem("od_state")).toBeNull();

    // The exchange used PKCE (verifier, not a secret) and the stored redirect URI.
    const body = String(calls[0].init?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=the-verifier");
    expect(body).toContain(`client_id=${CLIENT_ID}`);
    expect(body).not.toContain("client_secret");
  });

  it("fails the auth when the token exchange fails", async () => {
    g.sessionStorage!.setItem("od_state", "s");
    g.sessionStorage!.setItem("od_verifier", "v");
    g.sessionStorage!.setItem("od_redirect_uri", "https://example.com/app/");
    mockFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const provider = new OneDriveProvider(CLIENT_ID);
    const ok = await provider.resumeAuth(new URL("https://example.com/app/?code=c&state=s"));
    expect(ok).toBe(false);
    expect(provider.getAuthFailure()?.kind).toBe("error");
    expect(provider.refreshToken).toBeNull();
  });
});

describe("OneDriveProvider session", () => {
  it("init() reports a session only when a refresh token is stored", async () => {
    expect(await new OneDriveProvider(CLIENT_ID).init()).toBe(false);
    g.localStorage!.setItem("od_access", "a");
    expect(await new OneDriveProvider(CLIENT_ID).init()).toBe(false);
    g.localStorage!.setItem("od_refresh", "r");
    expect(await new OneDriveProvider(CLIENT_ID).init()).toBe(true);
  });

  it("refreshes an expired access token lazily on the first API call", async () => {
    g.localStorage!.setItem("od_refresh", "refresh-1");
    g.localStorage!.setItem("od_access", "old-token");
    g.localStorage!.setItem("od_expires", "1"); // long expired
    mockFetch((url) => {
      if (url === OneDriveProvider.TOKEN_URL) {
        // Microsoft rotates the refresh token on every use.
        return new Response(JSON.stringify({ access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3600 }), { status: 200 });
      }
      if (url === `${GRAPH}/me/drive/special/approot:/data.json:/content`) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url === `${GRAPH}/me/drive/special/approot:/data.json:?$select=id,name,eTag`) {
        return new Response(JSON.stringify({ id: "item-1", name: "data.json", eTag: "etag-1" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = new OneDriveProvider(CLIENT_ID);
    const remote = await provider.load();
    expect(remote?.data).toEqual({ items: [] });
    expect(remote?.rev).toBe("etag-1");
    expect(provider.accessToken).toBe("fresh-token");
    expect(provider.refreshToken).toBe("refresh-2");
    expect(provider.fileId).toBe("item-1");
    // The item id is reused on the next calls (survives renames).
    expect(provider._itemPath()).toBe("/me/drive/items/item-1");
  });

  it("returns null when the data file does not exist", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 }));
    const provider = loggedInProvider();
    expect(await provider.load()).toBeNull();
  });

  it("disconnect() clears every stored credential", async () => {
    g.localStorage!.setItem("od_refresh", "r");
    g.localStorage!.setItem("od_access", "a");
    g.localStorage!.setItem("od_user_email", "u@e.com");
    const provider = new OneDriveProvider(CLIENT_ID);
    await provider.disconnect();
    expect(g.localStorage!.getItem("od_refresh")).toBeNull();
    expect(g.localStorage!.getItem("od_access")).toBeNull();
    expect(g.localStorage!.getItem("od_user_email")).toBeNull();
    expect((await provider.getStatus()).isConnected).toBe(false);
  });
});

describe("OneDriveProvider data", () => {
  it("saves by item id once known, by name otherwise", async () => {
    const paths: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "PUT" && url.endsWith("/content")) {
        paths.push(url.slice(GRAPH.length));
        return new Response(JSON.stringify({ id: "new-item-id", name: "data.json", eTag: "etag-new" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.save({ items: [] }, null)).toEqual({ status: "saved", rev: "etag-new" });
    expect(paths).toEqual(["/me/drive/special/approot:/data.json:/content"]);
    expect(provider.fileId).toBe("new-item-id");
    expect(await provider.save({ items: [] }, "etag-new")).toEqual({ status: "saved", rev: "etag-new" });
    expect(paths).toEqual(["/me/drive/special/approot:/data.json:/content", "/me/drive/items/new-item-id/content"]);
  });

  it("sends the base revision in the if-match header", async () => {
    let ifMatch: string | undefined;
    mockFetch((url, init) => {
      if (init?.method === "PUT" && url.endsWith("/content")) {
        ifMatch = (init.headers as Record<string, string>)["if-match"];
        return new Response(JSON.stringify({ id: "i", name: "data.json", eTag: "etag-2" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    await provider.save({ items: [] }, "etag-1");
    expect(ifMatch).toBe("etag-1");
  });

  it("reports 'conflict' on a 412 precondition failure", async () => {
    mockFetch((url, init) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: { code: "notAllowed" } }), { status: 412 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.save({ items: [] }, "etag-1")).toEqual({ status: "conflict" });
  });

  it("getRemoteRevision reads the item eTag", async () => {
    mockFetch((url) => {
      if (url === `${GRAPH}/me/drive/special/approot:/data.json:?$select=id,name,eTag`) {
        return new Response(JSON.stringify({ id: "item-1", name: "data.json", eTag: "etag-9" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = loggedInProvider();
    expect(await provider.getRemoteRevision()).toBe("etag-9");
    expect(provider.fileId).toBe("item-1");
  });

  it("getRemoteRevision returns null when the file does not exist", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 }));
    const provider = loggedInProvider();
    expect(await provider.getRemoteRevision()).toBeNull();
  });
});
