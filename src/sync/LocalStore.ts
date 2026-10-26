/**
 * Minimal key-value persistence the SyncEngine keeps its sync state in:
 * the local working copy, the last-synced base snapshot and its remote
 * revision, and the pending-changes flag. IndexedDB in the browser — not
 * localStorage (too small, synchronous). MemoryStore is exported for tests
 * and for apps that prefer in-memory only.
 */
export interface LocalStore {
  /**
   * @param key the entry key.
   * @returns the stored value, or undefined when absent.
   */
  get(key: string): Promise<unknown>;
  /**
   * @param key the entry key.
   * @param value the value to persist (structured-cloneable).
   * @returns resolves once stored.
   */
  set(key: string, value: unknown): Promise<void>;
  /**
   * @param key the entry key.
   * @returns resolves once removed.
   */
  delete(key: string): Promise<void>;
}

/** In-memory LocalStore — used by the test suite under Bun (no IndexedDB). */
export class MemoryStore implements LocalStore {
  _map = new Map<string, unknown>();
  get(key: string): Promise<unknown> { return Promise.resolve(this._map.get(key)); }
  set(key: string, value: unknown): Promise<void> { this._map.set(key, value); return Promise.resolve(); }
  delete(key: string): Promise<void> { this._map.delete(key); return Promise.resolve(); }
}

/** IndexedDB-backed LocalStore, a single object store of key → value. */
export class IdbStore implements LocalStore {
  _dbName: string;
  _storeName: string;
  _db: Promise<IDBDatabase> | null = null;

  /**
   * @param dbName the IndexedDB database name.
   * @param storeName the object-store name inside the database.
   */
  constructor(dbName = 'cloud-sync', storeName = 'state') {
    this._dbName = dbName;
    this._storeName = storeName;
  }

  _open(): Promise<IDBDatabase> {
    this._db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this._storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  _tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return this._open().then(db => db.transaction(this._storeName, mode).objectStore(this._storeName));
  }

  async get(key: string): Promise<unknown> {
    const store = await this._tx('readonly');
    return await new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: unknown): Promise<void> {
    const store = await this._tx('readwrite');
    await new Promise<void>((resolve, reject) => {
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key: string): Promise<void> {
    const store = await this._tx('readwrite');
    await new Promise<void>((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
