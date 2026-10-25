import { StorageProvider } from '../StorageProvider.js';
import type { StorageStatus, RemoteData, SaveResult } from '../StorageProvider.js';

/**
 * Read-only provider: data is fetched from a plain URL (e.g. a demo dataset
 * hosted anywhere) and kept in memory only — every save is silently dropped,
 * so a page reload restores the remote content. The revision token is the
 * HTTP ETag when the server sends one.
 */
export class ReadOnlyProvider extends StorageProvider {
  dataUrl: string;

  constructor(dataUrl: string) {
    super();
    this.dataUrl = dataUrl;
  }

  override init(): Promise<boolean> { return Promise.resolve(true); }
  override authenticate(): Promise<boolean> { return Promise.resolve(true); }
  override isReadOnly(): boolean { return true; }

  override async load(): Promise<RemoteData | null> {
    const response = await fetch(this.dataUrl);
    if (!response.ok) {
      throw new Error(`Read-only data fetch failed: HTTP ${response.status}`);
    }
    return { data: await response.json(), rev: response.headers.get('etag') };
  }

  /** Saves are dropped on purpose: edits live in memory only. */
  override save(): Promise<SaveResult> { return Promise.resolve({ status: 'saved', rev: null }); }

  override getStatus(): Promise<StorageStatus> {
    return Promise.resolve({ isConnected: true, providerName: 'Read-only' });
  }

  override getDataLocation(): Promise<string | null> {
    return Promise.resolve(this.dataUrl);
  }
}
