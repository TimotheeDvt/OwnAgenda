/**
 * - signedIn: the app can read and write the storage right now
 * - expired: someone signed in on this device before, but the session ran out (Google access
 *   tokens last about an hour and, without a backend, can't be renewed without a popup; a Solid
 *   session can't be renewed silently once the provider's own login expired). The app stays
 *   usable read-only and offers a one-tap "Reconnect".
 * - signedOut: nobody is signed in on this device
 */
export type AuthState = 'signedIn' | 'expired' | 'signedOut';
export type AuthListener = (state: AuthState) => void;

export class AuthError extends Error {
  override name = 'AuthError';
}

/** localStorage, ignoring failures (private mode, blocked site data): nothing is remembered. */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: nothing is remembered.
  }
}
