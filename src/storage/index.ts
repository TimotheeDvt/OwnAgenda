import { googleDriveProvider } from './googleDrive';
import type { StorageProvider } from './types';

export type { FileListing, FileMeta, StorageProvider, StorageUser } from './types';

let provider: StorageProvider = googleDriveProvider;

/** The storage the app reads from and writes to. */
export function storage(): StorageProvider {
  return provider;
}

/** Switches storage (e.g. when more providers exist, or an in-memory fake in tests). */
export function setStorageProvider(next: StorageProvider): void {
  provider = next;
}
