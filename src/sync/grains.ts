/** Identifier of a grain inside the data file. */
export type GrainId = string;

/** Content hash of a grain; null stands for "grain absent". */
export type Hash = string | null;

/**
 * How an app cuts its data file into grains — the independently reconcilable
 * pieces (a vehicle, an asset, a row…). It is the only app-specific code
 * sync requires. Both functions must be pure and lossless:
 * `join(split(data))` has to rebuild an equivalent payload.
 */
export interface GrainCodec {
  /**
   * @param data the data-file payload; null/undefined when there is none yet.
   * @returns the grains keyed by id — insertion order is the display order
   *          and is kept by merges. An empty map for null/undefined data.
   */
  split(data: unknown): Map<GrainId, unknown>;
  /**
   * @param grains the grains of a merged working copy.
   * @returns the data-file payload rebuilt from them.
   */
  join(grains: Map<GrainId, unknown>): unknown;
}

/** Id of the single grain of a whole-file app. */
export const WHOLE_FILE_GRAIN = '';

/** Default codec: the whole file is one grain (the conservative stance —
 *  any divergence of the file is a conflict). */
export const wholeFileCodec: GrainCodec = {
  split: data => data == null ? new Map() : new Map([[WHOLE_FILE_GRAIN, data]]),
  join: grains => grains.get(WHOLE_FILE_GRAIN) ?? null
};

/** Hashes a grain; must be deterministic and equal for equal content. */
export type GrainHasher = (grain: unknown) => string | Promise<string>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON with object keys sorted — equal content gives an equal string
 *  whatever the key order (the cloud file may have been rewritten). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isPlainObject(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
      : v
  );
}

/** Default hasher: hex SHA-256 of the grain's canonical JSON. */
export const sha256Hasher: GrainHasher = async (grain) => {
  const bytes = new TextEncoder().encode(canonicalJson(grain));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * @param grains the grains to hash.
 * @param hasher the grain hasher.
 * @returns id → hash for every grain (absent grains are simply not listed).
 */
export async function hashAll(grains: Map<GrainId, unknown>, hasher: GrainHasher): Promise<Map<GrainId, string>> {
  const entries = await Promise.all(
    [...grains].map(async ([id, grain]) => [id, await hasher(grain)] as const)
  );
  return new Map(entries);
}

/** Outcome of the grain-by-grain three-way decision. */
export interface Decision {
  /** Grains whose local version must win (and be pushed). Every other grain
   *  takes the cloud version — including its deletion. */
  keepLocal: Set<GrainId>;
  /** Grains edited differently on both sides: a user decision is needed. */
  conflicts: GrainId[];
}

/**
 * Three-way decision per grain, from content hashes only — no copy of the
 * source version is ever needed:
 * - `local === source` — not edited here → take the cloud version;
 * - `local === remote` — same edit on both sides → nothing to do;
 * - `remote === source` — edited only here → keep local;
 * - otherwise — edited differently on both sides → conflict.
 * Absent grains hash to null, so a local deletion (null vs a source hash), a
 * remote deletion and a creation on either side fall out of the same rules.
 *
 * @param local hashes of the local working copy.
 * @param remote hashes of the cloud version being merged in.
 * @param source hashes of the cloud version the local copy was read from.
 * @returns the grains to keep local and the ones in conflict.
 */
export function decide(
  local: Map<GrainId, string>, remote: Map<GrainId, string>, source: Map<GrainId, string>
): Decision {
  const keepLocal = new Set<GrainId>();
  const conflicts: GrainId[] = [];
  for (const id of new Set([...local.keys(), ...remote.keys(), ...source.keys()])) {
    const l = local.get(id) ?? null;
    const r = remote.get(id) ?? null;
    const src = source.get(id) ?? null;
    if (l === src || l === r) continue;
    if (r === src) keepLocal.add(id);
    else conflicts.push(id);
  }
  return { keepLocal, conflicts };
}
