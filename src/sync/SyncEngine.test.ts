/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { SyncEngine } from "./SyncEngine.js";
import type { SyncEngineOptions, SyncStatus } from "./SyncEngine.js";
import { MemoryStore } from "./LocalStore.js";
import type { GrainCodec } from "./grains.js";
import { StorageProvider } from "../StorageProvider.js";
import type { RemoteData, SaveResult, StorageStatus } from "../StorageProvider.js";

type Item = { id: string; v: number };
type Payload = { items: Item[] };

/** Toy app data: a list of items, each one a grain. */
const itemsCodec: GrainCodec = {
  split: d => new Map(((d as Payload | null)?.items ?? []).map(i => [i.id, i])),
  join: g => ({ items: [...g.values()] as Item[] })
};
const payload = (...items: [string, number][]): Payload => ({ items: items.map(([id, v]) => ({ id, v })) });

/** Scripted in-memory provider driving the engine through sync scenarios. */
class FakeProvider extends StorageProvider {
  remote: { data: unknown; rev: string } | null = { data: payload(["a", 1], ["b", 1]), rev: "r1" };
  /** Every save() attempt, refused ones included. */
  saves: { data: unknown; baseRev: string | null }[] = [];
  nextResult: SaveResult | "throw-network" | "throw-http" | null = null;
  /** When set, the next save() waits for it (simulates a slow in-flight push). */
  gate: Promise<void> | null = null;
  _counter = 1;
  authenticate() { return Promise.resolve(true); }
  override init() { return Promise.resolve(true); }
  load(): Promise<RemoteData | null> {
    return Promise.resolve(this.remote ? { data: this.remote.data, rev: this.remote.rev } : null);
  }
  save(data: unknown, baseRev: string | null): Promise<SaveResult> {
    const gate = this.gate;
    this.gate = null;
    return gate ? gate.then(() => this._save(data, baseRev)) : this._save(data, baseRev);
  }
  _save(data: unknown, baseRev: string | null): Promise<SaveResult> {
    this.saves.push({ data, baseRev });
    if (this.nextResult === "throw-network") { this.nextResult = null; return Promise.reject(new TypeError("fetch failed")); }
    if (this.nextResult === "throw-http") { this.nextResult = null; return Promise.reject(new Error("upload failed: HTTP 500")); }
    if (this.nextResult) { const r = this.nextResult; this.nextResult = null; return Promise.resolve(r); }
    // Like the real providers: a null baseRev is an unconditional write.
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

function engine(options: SyncEngineOptions = {}, provider = new FakeProvider()): { e: SyncEngine; p: FakeProvider } {
  const e = new SyncEngine(provider, { store: new MemoryStore(), pollIntervalMs: 0, grains: itemsCodec, ...options });
  return { e, p: provider };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

/** Records the latest status the engine reports. */
function watchStatus(e: SyncEngine): { current: () => SyncStatus } {
  let status: SyncStatus | undefined;
  e.onStatus(s => { status = s; });
  return { current: () => status! };
}

/** An initialized engine parked on a conflict over grain "a" (local a=2, cloud a=9). */
async function parkedOnA(options: SyncEngineOptions = {}) {
  const { e, p } = engine(options);
  await e.init();
  p.remote = { data: payload(["a", 9], ["b", 1]), rev: "r2" };
  expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("conflict");
  return { e, p };
}

describe("SyncEngine basics", () => {
  it("loads the remote into the working copy on init", async () => {
    const { e } = engine();
    expect(await e.init()).toEqual(payload(["a", 1], ["b", 1]));
    expect(e.readRev).toBe("r1");
    expect(e._sourceHash.size).toBe(2);
  });

  it("keeps no data (not an empty file) when there is no remote file", async () => {
    const p = new FakeProvider();
    p.remote = null;
    const { e } = engine({}, p);
    expect(await e.init()).toBeNull();
    expect(e.readRev).toBeNull();
  });

  it("saves guarded by the revision it read and tracks the new one", async () => {
    const { e, p } = engine();
    await e.init();
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("saved");
    expect(p.saves.map(s => s.baseRev)).toEqual(["r1"]);
    expect(e.readRev).toBe("rev-2");
    expect(e._pending).toBe(false);
    expect(p.remote!.data).toEqual(payload(["a", 2], ["b", 1]));
  });

  it("queues on network failure and pushes once reachable", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("queued");
    expect(e._pending).toBe(true);
    await e._syncCycle();
    expect(e._pending).toBe(false);
    expect(p.remote!.data).toEqual(payload(["a", 2], ["b", 1]));
  });

  it("reports other failures as 'error' and keeps the edit pending", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-http";
    const status = watchStatus(e);
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("error");
    expect(e._pending).toBe(true);
    expect(status.current().lastError).toContain("HTTP 500");
  });

  it("restores a pending edit after a restart and pushes it", async () => {
    const store = new MemoryStore();
    const p = new FakeProvider();
    const first = engine({ store }, p).e;
    await first.init();
    p.nextResult = "throw-network";
    await first.save(payload(["a", 2], ["b", 1]));

    const second = engine({ store }, p).e;
    expect(await second.init()).toEqual(payload(["a", 2], ["b", 1]));
    await until(() => !second._pending);
    expect(p.remote!.data).toEqual(payload(["a", 2], ["b", 1]));
  });

  it("clears everything on reset", async () => {
    const { e } = engine();
    await e.init();
    await e.reset();
    expect(e.getLocal()).toBeNull();
    expect(e.readRev).toBeNull();
    expect(e._sourceHash.size).toBe(0);
  });
});

describe("grain reconciliation on a refused push", () => {
  it("merges edits made to different grains on both sides", async () => {
    const { e, p } = engine();
    await e.init();
    const received: unknown[] = [];
    e.onData(d => received.push(d));
    p.remote = { data: payload(["a", 1], ["b", 9]), rev: "r2" };
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 9]));
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 9]));
    expect(received).toEqual([payload(["a", 2], ["b", 9])]);
    expect(p.saves.map(s => s.baseRev)).toEqual(["r1", "r2"]);
  });

  it("does not push again when both sides made the same edit", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 2], ["b", 9]), rev: "r2" };
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("saved");
    expect(p.saves).toHaveLength(1); // only the refused attempt
    expect(e.readRev).toBe("r2");
    expect(e._pending).toBe(false);
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 9]));
  });

  it("keeps a local deletion while taking an unrelated remote edit", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 9], ["b", 1]), rev: "r2" };
    expect(await e.save(payload(["a", 1]))).toBe("saved"); // b deleted locally
    expect(p.remote.data).toEqual(payload(["a", 9]));
  });

  it("keeps remote creations instead of mistaking them for local deletions", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    await e.save(payload(["a", 2], ["b", 1]));
    p.remote = { data: payload(["a", 1], ["b", 1], ["c", 1]), rev: "r2" };
    await e._syncCycle();
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 1], ["c", 1]));
  });

  it("keeps local creations next to remote ones", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 1], ["b", 1], ["c", 1]), rev: "r2" };
    expect(await e.save(payload(["a", 1], ["b", 1], ["d", 1]))).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 1], ["b", 1], ["d", 1], ["c", 1]));
  });

  it("parks when the same grain was edited differently on both sides", async () => {
    const { e, p } = await parkedOnA();
    const status = watchStatus(e);
    expect(status.current().conflict).toBe(true);
    expect(status.current().conflicts).toEqual([
      { id: "a", local: { id: "a", v: 2 }, remote: { id: "a", v: 9 } }
    ]);
    expect(p.remote!.data).toEqual(payload(["a", 9], ["b", 1])); // cloud untouched
    expect(e.readRev).toBe("r1"); // nothing was read or applied
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 1]));
  });

  it("keeps edits made while parked locally, without pushing", async () => {
    const { e, p } = await parkedOnA();
    const pushes = p.saves.length;
    expect(await e.save(payload(["a", 2], ["b", 5]))).toBe("conflict");
    expect(p.saves).toHaveLength(pushes);
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 5]));
    expect(e._pending).toBe(true);
  });

  it("parks a local deletion against a remote edit, and a remote deletion against a local edit", async () => {
    const del = engine();
    await del.e.init();
    del.p.remote = { data: payload(["a", 9], ["b", 1]), rev: "r2" };
    expect(await del.e.save(payload(["b", 1]))).toBe("conflict");
    const delStatus = watchStatus(del.e).current();
    expect(delStatus.conflicts).toEqual([{ id: "a", local: null, remote: { id: "a", v: 9 } }]);

    const edit = engine();
    await edit.e.init();
    edit.p.remote = { data: payload(["b", 1]), rev: "r2" };
    expect(await edit.e.save(payload(["a", 2], ["b", 1]))).toBe("conflict");
    const editStatus = watchStatus(edit.e).current();
    expect(editStatus.conflicts).toEqual([{ id: "a", local: { id: "a", v: 2 }, remote: null }]);
  });

  it("parks when both sides created the same grain with different content", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 1], ["b", 1], ["c", 7]), rev: "r2" };
    expect(await e.save(payload(["a", 1], ["b", 1], ["c", 8]))).toBe("conflict");
    expect(watchStatus(e).current().conflicts!.map(c => c.id)).toEqual(["c"]);
  });

  it("never overwrites a file that appeared since the last read", async () => {
    const p = new FakeProvider();
    p.remote = null;
    const { e } = engine({}, p);
    await e.init();
    p.remote = { data: payload(["x", 1]), rev: "r5" }; // created by another device
    expect(await e.save(payload(["a", 1]))).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 1], ["x", 1]));
    expect(p.saves.map(s => s.baseRev)).toEqual(["r5"]); // the unconditional write was never sent
  });

  it("pushes the edits saved while a push is in flight", async () => {
    const { e, p } = engine();
    await e.init();
    let release!: () => void;
    p.gate = new Promise<void>(r => { release = r; });
    const first = e.save(payload(["a", 2], ["b", 1]));
    await until(() => p.gate === null); // the push is in flight, blocked in save()
    expect(await e.save(payload(["a", 3], ["b", 1]))).toBe("queued");
    release();
    expect(await first).toBe("saved");
    expect(e._pending).toBe(false);
    expect(p.remote!.data).toEqual(payload(["a", 3], ["b", 1]));
  });
});

describe("pull", () => {
  it("adopts the remote when nothing is edited locally and fires onData", async () => {
    const { e, p } = engine();
    await e.init();
    const received: unknown[] = [];
    e.onData(d => received.push(d));
    p.remote = { data: payload(["a", 1], ["b", 7], ["c", 1]), rev: "r2" };
    await e.pull();
    expect(e.getLocal()).toEqual(payload(["a", 1], ["b", 7], ["c", 1]));
    expect(e.readRev).toBe("r2");
    expect(received).toHaveLength(1);
    expect(p.saves).toHaveLength(0);
  });

  it("drops a grain deleted remotely when it was not edited locally", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 1]), rev: "r2" };
    await e.pull();
    expect(e.getLocal()).toEqual(payload(["a", 1]));
  });

  it("does not fire onData when the revision moved but the content did not", async () => {
    const { e, p } = engine();
    await e.init();
    let fired = 0;
    e.onData(() => fired++);
    p.remote = { data: payload(["a", 1], ["b", 1]), rev: "r2" };
    await e.pull();
    expect(fired).toBe(0);
    expect(e.readRev).toBe("r2");
  });

  it("detects a remote change without merging when eagerPull is off", async () => {
    const { e, p } = engine({ eagerPull: false });
    await e.init();
    const status = watchStatus(e);
    p.remote = { data: payload(["a", 1], ["b", 7]), rev: "r2" };
    await e._syncCycle();
    expect(status.current().remoteChanged).toBe(true);
    expect(e.getLocal()).toEqual(payload(["a", 1], ["b", 1]));
    await e.pull();
    expect(status.current().remoteChanged).toBe(false);
    expect(e.getLocal()).toEqual(payload(["a", 1], ["b", 7]));
  });

  it("merges into pending edits and pushes them right after", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    await e.save(payload(["a", 2], ["b", 1]));
    p.remote = { data: payload(["a", 1], ["b", 9]), rev: "r2" };
    await e.pull();
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 9]));
    await until(() => !e._syncing && !e._pending);
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 9]));
  });

  it("keeps the local edits when the cloud moves again after a pull-time merge", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    await e.save(payload(["a", 2], ["b", 1]));
    p.remote = { data: payload(["a", 1], ["b", 1], ["c", 1]), rev: "r2" };
    p.nextResult = "throw-network"; // the push that follows the pull fails too
    await e.pull();
    await until(() => !e._syncing);
    expect(e._pending).toBe(true);
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 1], ["c", 1]));

    p.remote = { data: payload(["a", 1], ["b", 1], ["c", 1], ["d", 1]), rev: "r3" };
    await e._syncCycle();
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 1], ["c", 1], ["d", 1]));
  });

  it("parks on a pull when both sides edited the same grain", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    await e.save(payload(["a", 2], ["b", 1]));
    p.remote = { data: payload(["a", 9], ["b", 1]), rev: "r2" };
    await e.pull();
    expect(watchStatus(e).current().conflict).toBe(true);
  });
});

describe("resolveConflict", () => {
  it("keeps the local version of every conflicting grain with 'local'", async () => {
    const { e, p } = await parkedOnA();
    expect(await e.resolveConflict("local")).toBe("saved");
    expect(p.remote!.data).toEqual(payload(["a", 2], ["b", 1]));
    expect(watchStatus(e).current().conflict).toBe(false);
  });

  it("takes the cloud version with 'remote', without pushing", async () => {
    const { e, p } = await parkedOnA();
    const pushes = p.saves.length;
    const received: unknown[] = [];
    e.onData(d => received.push(d));
    expect(await e.resolveConflict("remote")).toBe("saved");
    expect(e.getLocal()).toEqual(payload(["a", 9], ["b", 1]));
    expect(p.saves).toHaveLength(pushes);
    expect(received).toHaveLength(1);
    expect(e._pending).toBe(false);
    expect(e.readRev).toBe("r2");
  });

  it("decides each conflicting grain on its own", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 9], ["b", 9]), rev: "r2" };
    expect(await e.save(payload(["a", 2], ["b", 2]))).toBe("conflict");
    expect(await e.resolveConflict({ a: "local", b: "remote" })).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 9]));
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 9]));
  });

  it("pushes a version produced by the app, and deletes on a null merge", async () => {
    const merged = await parkedOnA();
    expect(await merged.e.resolveConflict({ a: { merged: { id: "a", v: 5 } } })).toBe("saved");
    expect(merged.p.remote!.data).toEqual(payload(["a", 5], ["b", 1]));
    expect(merged.e.getLocal()).toEqual(payload(["a", 5], ["b", 1]));

    const deleted = await parkedOnA();
    expect(await deleted.e.resolveConflict({ a: { merged: null } })).toBe("saved");
    expect(deleted.p.remote!.data).toEqual(payload(["b", 1]));
  });

  it("moves on to the next grain when an edit made meanwhile conflicts too", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 9], ["b", 9]), rev: "r2" };
    expect(await e.save(payload(["a", 2], ["b", 1]))).toBe("conflict"); // only a conflicts
    await e.save(payload(["a", 2], ["b", 5])); // b edited meanwhile: now it conflicts too
    const pushes = p.saves.length;
    expect(await e.resolveConflict({ a: "local" })).toBe("conflict");
    expect(watchStatus(e).current().conflicts!.map(c => c.id)).toEqual(["b"]); // a is settled
    expect(e.getLocal()).toEqual(payload(["a", 2], ["b", 5]));
    expect(p.saves).toHaveLength(pushes); // nothing pushed while b is undecided
    expect(await e.resolveConflict({ b: "remote" })).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 9]));
  });

  it("applies each choice at once and stays parked on the grains left undecided", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 9], ["b", 9]), rev: "r2" };
    await e.save(payload(["a", 2], ["b", 2]));
    const received: unknown[] = [];
    e.onData(d => received.push(d));
    const pushes = p.saves.length;

    expect(await e.resolveConflict({ a: "remote" })).toBe("conflict");
    expect(e.getLocal()).toEqual(payload(["a", 9], ["b", 2])); // a taken right away
    expect(received).toEqual([payload(["a", 9], ["b", 2])]);
    expect(watchStatus(e).current().conflicts).toEqual([
      { id: "b", local: { id: "b", v: 2 }, remote: { id: "b", v: 9 } }
    ]);
    expect(p.saves).toHaveLength(pushes);

    expect(await e.resolveConflict({ b: "local" })).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 9], ["b", 2]));
    expect(e._pending).toBe(false);
  });

  it("keeps the grains settled so far across a restart", async () => {
    const store = new MemoryStore();
    const p = new FakeProvider();
    const first = engine({ store }, p).e;
    await first.init();
    p.remote = { data: payload(["a", 9], ["b", 9]), rev: "r2" };
    await first.save(payload(["a", 2], ["b", 2]));
    await first.resolveConflict({ a: "local" });

    const second = engine({ store }, p).e;
    await second.init();
    expect(watchStatus(second).current().conflicts!.map(c => c.id)).toEqual(["b"]);
    expect(await second.resolveConflict({ b: "remote" })).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 9]));
  });

  it("applies a plain side to a conflict that appeared while parked", async () => {
    const { e, p } = engine();
    await e.init();
    p.remote = { data: payload(["a", 9], ["b", 9]), rev: "r2" };
    await e.save(payload(["a", 2], ["b", 1]));
    await e.save(payload(["a", 2], ["b", 5]));
    expect(await e.resolveConflict("local")).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 5]));
  });

  it("parks again when the cloud moved once more on the same grain", async () => {
    const { e, p } = await parkedOnA();
    p.remote = { data: payload(["a", 10], ["b", 1]), rev: "r3" };
    expect(await e.resolveConflict("local")).toBe("conflict");
    expect(watchStatus(e).current().conflicts).toEqual([
      { id: "a", local: { id: "a", v: 2 }, remote: { id: "a", v: 10 } }
    ]);
    expect(await e.resolveConflict("local")).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 1]));
  });

  it("keeps the conflict across a restart", async () => {
    const store = new MemoryStore();
    const p = new FakeProvider();
    const first = engine({ store }, p).e;
    await first.init();
    p.remote = { data: payload(["a", 9], ["b", 1]), rev: "r2" };
    await first.save(payload(["a", 2], ["b", 1]));

    const second = engine({ store }, p).e;
    await second.init();
    const status = watchStatus(second).current();
    expect(status.conflict).toBe(true);
    expect(status.conflicts).toEqual([{ id: "a", local: { id: "a", v: 2 }, remote: { id: "a", v: 9 } }]);
    expect(await second.resolveConflict("local")).toBe("saved");
    expect(p.remote.data).toEqual(payload(["a", 2], ["b", 1]));
  });
});

describe("whole-file app (default codec)", () => {
  const wholeFile = { grains: undefined };

  it("treats any divergence of the file as a conflict, and resolves it for the whole file", async () => {
    const p = new FakeProvider();
    p.remote = { data: { v: 1 }, rev: "r1" };
    const { e } = engine(wholeFile, p);
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    expect(await e.save({ v: 2 })).toBe("conflict");
    expect(watchStatus(e).current().conflicts).toEqual([{ id: "", local: { v: 2 }, remote: { v: 9 } }]);
    expect(await e.resolveConflict("local")).toBe("saved");
    expect(p.remote.data).toEqual({ v: 2 });
  });

  it("accepts an app-produced version under the whole-file grain id", async () => {
    const p = new FakeProvider();
    p.remote = { data: { v: 1 }, rev: "r1" };
    const { e } = engine(wholeFile, p);
    await e.init();
    p.remote = { data: { v: 9 }, rev: "r2" };
    await e.save({ v: 2 });
    expect(await e.resolveConflict({ "": { merged: { v: 3 } } })).toBe("saved");
    expect(p.remote.data).toEqual({ v: 3 });
  });
});

describe("setProvider", () => {
  it("merges the pending edits into what the new provider already holds", async () => {
    const { e, p } = engine();
    await e.init();
    p.nextResult = "throw-network";
    await e.save(payload(["a", 2], ["b", 1]));

    const other = new FakeProvider();
    other.remote = { data: payload(["c", 1]), rev: "x1" };
    await e.setProvider(other);
    await until(() => !e._pending && !e._syncing);
    expect(other.remote.data).toEqual(payload(["a", 2], ["b", 1], ["c", 1]));
  });
});
