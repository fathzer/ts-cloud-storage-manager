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
});
