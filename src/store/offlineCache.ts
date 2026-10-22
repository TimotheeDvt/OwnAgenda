// Offline copy of the last Drive state in IndexedDB, so the agenda shows instantly on startup
// and stays readable when Drive can't be reached. Drive remains the source of truth: the copy is
// replaced by fresh data as soon as Drive answers.

import type { FileMeta } from '../storage';

const DB_NAME = 'ics-agenda';
const DB_VERSION = 1;
const STORE = 'cache';
const KEY = 'snapshot';

export interface CachedFile {
  meta: FileMeta;
  content: string;
}

export interface OfflineSnapshot {
  /** Storage the data came from (StorageProvider.id). Missing in copies saved before it existed. */
  provider?: string;
  /** Account the data belongs to; a different account never sees it. */
  email: string;
  settings: unknown;
  files: CachedFile[];
  savedAt: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        // IndexedDB unavailable (private mode in some browsers): no offline copy.
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = action(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve((request.result as T) ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export function readSnapshot(): Promise<OfflineSnapshot | null> {
  return run<OfflineSnapshot>('readonly', (store) => store.get(KEY));
}

export async function writeSnapshot(snapshot: OfflineSnapshot): Promise<void> {
  await run('readwrite', (store) => store.put(snapshot, KEY));
}

export async function clearSnapshot(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY));
}
