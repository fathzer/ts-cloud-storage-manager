/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import { canonicalJson, decide, hashAll, sha256Hasher, wholeFileCodec, WHOLE_FILE_GRAIN } from "./grains.js";

const h = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("decide", () => {
  const none = h({});

  it("takes the cloud version of a grain not edited locally", () => {
    const d = decide(h({ a: "1" }), h({ a: "2" }), h({ a: "1" }));
    expect(d.keepLocal.size).toBe(0);
    expect(d.conflicts).toEqual([]);
  });

  it("keeps a grain edited only locally", () => {
    const d = decide(h({ a: "2" }), h({ a: "1" }), h({ a: "1" }));
    expect([...d.keepLocal]).toEqual(["a"]);
    expect(d.conflicts).toEqual([]);
  });

  it("does nothing when both sides made the same edit", () => {
    const d = decide(h({ a: "2" }), h({ a: "2" }), h({ a: "1" }));
    expect(d.keepLocal.size).toBe(0);
    expect(d.conflicts).toEqual([]);
  });

  it("conflicts when both sides edited the grain differently", () => {
    const d = decide(h({ a: "2" }), h({ a: "3" }), h({ a: "1" }));
    expect(d.conflicts).toEqual(["a"]);
  });

  it("keeps a local deletion when the cloud did not touch the grain", () => {
    const d = decide(none, h({ a: "1" }), h({ a: "1" }));
    expect([...d.keepLocal]).toEqual(["a"]);
  });

  it("conflicts on a local deletion against a remote edit", () => {
    expect(decide(none, h({ a: "2" }), h({ a: "1" })).conflicts).toEqual(["a"]);
  });

  it("drops a remotely deleted grain that was not edited locally", () => {
    const d = decide(h({ a: "1" }), none, h({ a: "1" }));
    expect(d.keepLocal.size).toBe(0);
    expect(d.conflicts).toEqual([]);
  });

  it("conflicts on a remote deletion against a local edit", () => {
    expect(decide(h({ a: "2" }), none, h({ a: "1" })).conflicts).toEqual(["a"]);
  });

  it("tells a remote creation from a local deletion", () => {
    // Absent locally, absent from the source, present in the cloud: created
    // remotely — must be taken, not mistaken for a deletion to keep.
    const d = decide(none, h({ a: "1" }), none);
    expect(d.keepLocal.size).toBe(0);
    expect(d.conflicts).toEqual([]);
  });

  it("keeps a local creation", () => {
    expect([...decide(h({ a: "1" }), none, none).keepLocal]).toEqual(["a"]);
  });

  it("conflicts when both sides created the grain with different content", () => {
    expect(decide(h({ a: "1" }), h({ a: "2" }), none).conflicts).toEqual(["a"]);
    expect(decide(h({ a: "1" }), h({ a: "1" }), none).conflicts).toEqual([]);
  });
});

describe("hashing", () => {
  it("is independent from the key order", async () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } }))
      .toBe(canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 1 }, b: 1 }));
    expect(await sha256Hasher({ a: 1, b: 2 })).toBe(await sha256Hasher({ b: 2, a: 1 }));
  });

  it("differs when the content differs", async () => {
    expect(await sha256Hasher({ a: 1 })).not.toBe(await sha256Hasher({ a: 2 }));
  });

  it("ignores what JSON drops, as the cloud file does", async () => {
    expect(await sha256Hasher({ a: 1, b: undefined })).toBe(await sha256Hasher({ a: 1 }));
  });

  it("hashes every grain of a map", async () => {
    const hashes = await hashAll(new Map([["a", { v: 1 }], ["b", { v: 2 }]]), sha256Hasher);
    expect([...hashes.keys()]).toEqual(["a", "b"]);
    expect(hashes.get("a")).toBe(await sha256Hasher({ v: 1 }));
  });
});

describe("wholeFileCodec", () => {
  it("makes the file a single grain, and none for missing data", () => {
    expect(wholeFileCodec.split(null).size).toBe(0);
    const grains = wholeFileCodec.split({ v: 1 });
    expect([...grains.keys()]).toEqual([WHOLE_FILE_GRAIN]);
    expect(wholeFileCodec.join(grains)).toEqual({ v: 1 });
    expect(wholeFileCodec.join(new Map())).toBeNull();
  });
});
