/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { SyncEngine, UNRECONCILABLE } from "./SyncEngine.js";
import { MemoryStore } from "./LocalStore.js";
import { StorageProvider } from "../StorageProvider.js";
import type { RemoteData, SaveResult, StorageStatus } from "../StorageProvider.js";
import type { MergePolicy } from "./SyncEngine.js";

/** Scripted in-memory provider driving the engine through sync scenarios. */
class FakeProvider extends StorageProvider {
  remote: { data: unknown; rev: string } | null = { data: { v: 1 }, rev: "r1" };
  savedRev: string | null = null;
  nextResult: SaveResult | "throw-network" | null = null;
  _counter = 1;
  authenticate() { return Promise.resolve(true); }
  override init() { return Promise.resolve(true); }
  load(): Promise<RemoteData | null> {
    return Promise.resolve(this.remote ? { data: this.remote.data, rev: this.remote.rev } : null);
  }
  save(data: unknown, baseRev: string | null): Promise<SaveResult> {
    this.savedRev = baseRev;
    if (this.nextResult === "throw-network") { this.nextResult = null; return Promise.reject(new TypeError("fetch failed")); }
    if (this.nextResult) { const r = this.nextResult; this.nextResult = null; return Promise.resolve(r); }
    if (baseRev !== null && this.remote && baseRev !== this.remote.rev) {
      return Promise.resolve({ status: "conflict" });
    }
    this.remote = { data, rev: `rev-${++this._counter}` };
    return Promise.resolve({ status: "saved", rev: this.remote.rev });
  }
  override getRemoteRevision(): Promise<string | null> {
    return Promise.resolve(this.remote?.rev ?? null);
  }
  getStatus(): Promise<StorageStatus> { return Promise.resolve({ isConnected: true, providerName: "fake" }); }
}

const takeRemote: MergePolicy = ({ remote }) => remote;
const preferLocal: MergePolicy = ({ base, local, remote }) => {
  // toy grain merge: {v} numeric field, keep the changed side
  return (local as { v: number }).v !== (base as { v: number }).v ? local : remote;
};
const never: MergePolicy = () => UNRECONCILABLE;

function engine(policy: MergePolicy, provider = new FakeProvider()): { e: SyncEngine; p: FakeProvider } {
  const e = new SyncEngine(provider, policy, { store: new MemoryStore(), pollIntervalMs: 0 });
  return { e, p: provider };
}

describe("SyncEngine", () => {
  it("loads remote into base+local on init", async () => {
    const { e } = engine(takeRemote);
    expect(await e.init()).toEqual({ v: 1 });
    expect(e.baseRev).toBe("r1");
  });

  it("saves and tracks the new revision", async () => {
    const { e, p } = engine(takeRemote);
    await e.init();
    expect(await e.save({ v: 2 })).toBe("saved");
    expect(e.baseRev).toBe("rev-2");
    expect((p.remote!.data as { v: number }).v).toBe(2);
  });

  it("queues on network failure and pushes once reachable", async () => {
    const { e, p } = engine(takeRemote);
    await e.init();
    p.nextResult = "throw-network";
    expect(await e.save({ v: 3 })).toBe("queued");
    expect((await e.onStatus(() => {}), true)).toBe(true);
    expect(await e.save({ v: 3 })).toBe("saved");
  });

  it("merges automatically via the policy on write conflict", async () => {
    const { e, p } = engine(preferLocal);
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" }; // remote moved since base r1
    let merged: unknown;
    e.onData(d => { merged = d; });
    expect(await e.save({ v: 2 })).toBe("saved");
    expect(merged).toEqual({ v: 2 }); // local change wins this toy policy
  });

  it("parks on an unreconcilable conflict until resolveConflict", async () => {
    const { e, p } = engine(never);
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    expect(await e.save({ v: 2 })).toBe("conflict");
    let status = { conflict: false };
    e.onStatus(s => { status = s; });
    expect(status.conflict).toBe(true);
    expect(await e.resolveConflict("local")).toBe("saved");
    expect((p.remote!.data as { v: number }).v).toBe(2);
    expect(status.conflict).toBe(false);
  });

  it("pushes an app-reconciled version over the remote head", async () => {
    const { e, p } = engine(never);
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    expect(await e.save({ v: 2 })).toBe("conflict");
    expect(await e.resolveConflict({ merged: { v: 11 } })).toBe("saved");
    expect((p.remote!.data as { v: number }).v).toBe(11);
    expect(e.getLocal()).toEqual({ v: 11 });
  });

  it("takes remote wholesale on pull when local is clean", async () => {
    const { e, p } = engine(takeRemote);
    await e.init();
    p.remote = { data: { v: 7 }, rev: "r2" };
    let received: unknown;
    e.onData(d => { received = d; });
    await e.pull();
    expect(received).toEqual({ v: 7 });
    expect(e.baseRev).toBe("r2");
  });

  it("hands baseRev and remoteRev to the merge policy", async () => {
    const p = new FakeProvider();
    let ctx: { baseRev?: string | null; remoteRev?: string | null } = {};
    const e = new SyncEngine(p, (c) => { ctx = c; return c.local; }, { store: new MemoryStore(), pollIntervalMs: 0 });
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    await e.save({ v: 2 });
    expect(ctx.baseRev).toBe("r1");
    expect(ctx.remoteRev).toBe("r2");
  });

  it("emits the synced revision through onData", async () => {
    const { e, p } = engine(takeRemote);
    await e.init();
    let rev: string | null = null;
    e.onData((_d, r) => { rev = r; });
    p.remote = { data: { v: 7 }, rev: "r2" };
    await e.pull();
    expect(rev).toBe("r2");
  });

  it("routes wholesale adoptions through options.adopt, merges through the policy", async () => {
    const calls: string[] = [];
    const policy: MergePolicy = (c) => { calls.push("merge"); return c.remote; };
    const adopt = (data: unknown, rev: string | null) => {
      calls.push(`adopt:${rev}`);
      return { ...(data as Record<string, unknown>), stamped: rev };
    };
    const p = new FakeProvider();
    const e = new SyncEngine(p, policy, { store: new MemoryStore(), pollIntervalMs: 0, adopt });
    // init adopts the remote payload through the hook
    expect(await e.init()).toEqual({ v: 1, stamped: "r1" });
    // clean pull adopts too
    p.remote = { data: { v: 7 }, rev: "r2" };
    await e.pull();
    expect(e.getLocal()).toEqual({ v: 7, stamped: "r2" });
    expect(calls).toEqual(["adopt:r1", "adopt:r2"]);
    // a divergent pull runs merge, not adopt
    p.remote = { data: { v: 8 }, rev: "r3" };
    await e.save({ v: 5 }); // merged output (remote) is re-pushed — no adopt call
    expect(calls).toEqual(["adopt:r1", "adopt:r2", "merge"]);
  });

  it("persistBase:false skips the base snapshot and passes base:null", async () => {
    const store = new MemoryStore();
    const p = new FakeProvider();
    let ctxBase: unknown = "unset";
    const e = new SyncEngine(p, (c) => { ctxBase = c.base; return c.local; }, {
      store, pollIntervalMs: 0, persistBase: false
    });
    await e.init();
    expect(await store.get(SyncEngine.K_BASE)).toBeUndefined();
    p.remote = { data: { v: 9 }, rev: "r2" };
    await e.save({ v: 2 });
    expect(ctxBase).toBeNull();
  });

  it("persistBase:false purges a stale stored base and keeps none in memory", async () => {
    const store = new MemoryStore();
    await store.set(SyncEngine.K_BASE, { stale: true });
    const e = new SyncEngine(new FakeProvider(), takeRemote, { store, pollIntervalMs: 0, persistBase: false });
    await e.init();
    expect(await store.get(SyncEngine.K_BASE)).toBeUndefined();
    expect(e._base).toBeNull();
    await e.save({ v: 2 });
    expect(e._base).toBeNull();
    expect(await store.get(SyncEngine.K_BASE)).toBeUndefined();
  });

  it("emits the merged-against remote revision when a refused push merges", async () => {
    const { e, p } = engine(takeRemote);
    await e.init();
    const revs: (string | null)[] = [];
    e.onData((_d, r) => revs.push(r));
    p.remote = { data: { v: 9 }, rev: "r2" };
    expect(await e.save({ v: 2 })).toBe("saved");
    expect(revs).toEqual(["r2"]);
  });

  it("uses the adopt return value as is, even null", async () => {
    const e = new SyncEngine(new FakeProvider(), takeRemote, {
      store: new MemoryStore(), pollIntervalMs: 0, adopt: () => null
    });
    expect(await e.init()).toBeNull();
    expect(e.getLocal()).toBeNull();
  });

  it("adopts only on the 'remote' resolution, not on 'local' or {merged}", async () => {
    const adopted: (string | null)[] = [];
    const park = async (resolution: "local" | "remote" | { merged: unknown }) => {
      adopted.length = 0;
      const p = new FakeProvider();
      const e = new SyncEngine(p, never, {
        store: new MemoryStore(), pollIntervalMs: 0, adopt: (d, r) => { adopted.push(r); return d; }
      });
      await e.init();
      adopted.length = 0; // ignore the init adoption
      p.remote = { data: { v: 9 }, rev: "r2" };
      expect(await e.save({ v: 2 })).toBe("conflict");
      await e.resolveConflict(resolution);
    };
    await park("local");
    expect(adopted).toEqual([]);
    await park({ merged: { v: 3 } });
    expect(adopted).toEqual([]);
    await park("remote");
    expect(adopted).toEqual(["r2"]);
  });

  it("keeps the base independent from the working copy mutated in place", async () => {
    const p = new FakeProvider();
    let ctxBase: unknown = null;
    const e = new SyncEngine(p, (c) => { ctxBase = c.base; return c.remote; }, {
      store: new MemoryStore(), pollIntervalMs: 0
    });
    const local = await e.init() as { v: number };
    local.v = 2; // the app edits its working copy in place…
    p.remote = { data: { v: 9 }, rev: "r2" };
    await e.save(local); // …then saves the same object
    expect(ctxBase).toEqual({ v: 1 });
  });

  it("keeps the remote data as merge base after a pull-time merge", async () => {
    const p = new FakeProvider();
    const bases: unknown[] = [];
    const e = new SyncEngine(p, (c) => { bases.push(c.base); return c.local; }, {
      store: new MemoryStore(), pollIntervalMs: 0
    });
    await e.init();
    p.nextResult = "throw-network";
    expect(await e.save({ v: 2 })).toBe("queued"); // pending local edit
    p.remote = { data: { v: 9 }, rev: "r2" };
    await e.pull(); // both moved: merge against base {v:1}
    expect(bases).toEqual([{ v: 1 }]);
    p.remote = { data: { v: 10 }, rev: "r3" }; // remote moves again before the push
    await e.save(e.getLocal());
    // the second merge must see the last remote head (r2) as base, not the merged result
    expect(bases[1]).toEqual({ v: 9 });
  });

  it("does not discard pending edits when 'remote' is chosen but the remote cannot be loaded", async () => {
    const p = new FakeProvider();
    const e = new SyncEngine(p, never, { store: new MemoryStore(), pollIntervalMs: 0 });
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    expect(await e.save({ v: 2 })).toBe("conflict");
    p.load = () => Promise.reject(new TypeError("fetch failed"));
    await e.resolveConflict("remote");
    expect(e.getLocal()).toEqual({ v: 2 });
    expect(e._pending).toBe(true);
  });

  it("keeps the base independent from the working copy after a save", async () => {
    const p = new FakeProvider();
    let ctxBase: unknown = null;
    const e = new SyncEngine(p, (c) => { ctxBase = c.base; return c.remote; }, {
      store: new MemoryStore(), pollIntervalMs: 0
    });
    await e.init();
    const data = { v: 2 };
    await e.save(data); // base is now the saved snapshot
    data.v = 3; // in-place edit of the same object
    p.remote = { data: { v: 9 }, rev: "r9" };
    await e.save(data);
    expect(ctxBase).toEqual({ v: 2 });
  });
});
