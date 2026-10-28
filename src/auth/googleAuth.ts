// Google sign-in (Google Identity Services, token model with popups).

import { GIS_SCRIPT_URL, GOOGLE_CLIENT_ID, SCOPES, TOKEN_EXPIRY_MARGIN_MS } from '../config';
import { AuthError, storageGet, storageSet, type AuthListener, type AuthState } from './types';

type Prompt = '' | 'consent' | 'select_account';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

// localStorage (not sessionStorage) so the session survives closing the installed app.
const TOKEN_STORAGE_KEY = 'ics-agenda.token';
const ACCOUNT_STORAGE_KEY = 'ics-agenda.account';

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let token: StoredToken | null = null;
let account: string | null = null;
let lastState: AuthState = 'signedOut';
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let pending: {
  promise: Promise<string>;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
} | null = null;
const listeners = new Set<AuthListener>();

function readStoredToken(): StoredToken | null {
  try {
    const parsed = JSON.parse(storageGet(TOKEN_STORAGE_KEY) ?? 'null') as StoredToken | null;
    return parsed && typeof parsed.accessToken === 'string' && typeof parsed.expiresAt === 'number'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isValid(t: StoredToken | null): t is StoredToken {
  return !!t && t.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now();
}

export function getAuthState(): AuthState {
  if (isValid(token)) return 'signedIn';
  return account ? 'expired' : 'signedOut';
}

function emitIfChanged(): void {
  const state = getAuthState();
  if (state === lastState) return;
  lastState = state;
  listeners.forEach((l) => l(state));
}

function setToken(value: StoredToken | null): void {
  token = value;
  storageSet(TOKEN_STORAGE_KEY, value ? JSON.stringify(value) : null);
  // Switch to "expired" by itself when the token runs out while the app is open.
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = value
    ? setTimeout(emitIfChanged, Math.max(0, value.expiresAt - TOKEN_EXPIRY_MARGIN_MS - Date.now()))
    : null;
  emitIfChanged();
}

/** Remembers which Google account is used, so later sign-ins skip the account chooser. */
export function rememberAccount(email: string): void {
  account = email;
  storageSet(ACCOUNT_STORAGE_KEY, email);
}

export function rememberedAccount(): string | null {
  return account;
}

function loadGisScript(): Promise<void> {
  if (typeof google !== 'undefined' && google.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new AuthError("Can't reach Google sign-in. Check your internet connection."));
    };
    document.head.appendChild(script);
  });
}

function handleTokenResponse(response: google.accounts.oauth2.TokenResponse): void {
  const current = pending;
  pending = null;
  if (response.error || !response.access_token) {
    current?.reject(
      new AuthError(response.error_description || response.error || 'Sign-in failed.'),
    );
    return;
  }
  if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...SCOPES)) {
    current?.reject(
      new AuthError('Google Drive access was not granted. Please allow all requested permissions.'),
    );
    return;
  }
  setToken({
    accessToken: response.access_token,
    expiresAt: Date.now() + Number(response.expires_in) * 1000,
  });
  current?.resolve(response.access_token);
}

function handleClientError(error: google.accounts.oauth2.ClientConfigError): void {
  const current = pending;
  pending = null;
  const message =
    error.type === 'popup_failed_to_open'
      ? 'The Google sign-in popup was blocked. Allow popups for this site and try again.'
      : error.type === 'popup_closed'
        ? 'The Google sign-in window was closed.'
        : (error.message ?? 'Sign-in failed.');
  current?.reject(new AuthError(message));
}

/** Loads Google Identity Services on first use (it may be unreachable when offline). */
async function ensureTokenClient(): Promise<google.accounts.oauth2.TokenClient> {
  if (tokenClient) return tokenClient;
  if (!GOOGLE_CLIENT_ID) {
    throw new AuthError('VITE_GOOGLE_CLIENT_ID is not set. See README for setup.');
  }
  await loadGisScript();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES.join(' '),
    callback: handleTokenResponse,
    error_callback: handleClientError,
  });
  return tokenClient;
}

/**
 * Restores the remembered account and token. Never needs the network: when offline, the app can
 * still start from its offline copy. Google's script is loaded in the background.
 */
export function initAuth(): void {
  if (!GOOGLE_CLIENT_ID) {
    throw new AuthError('VITE_GOOGLE_CLIENT_ID is not set. See README for setup.');
  }
  account = storageGet(ACCOUNT_STORAGE_KEY);
  const stored = readStoredToken();
  setToken(isValid(stored) ? stored : null);
  lastState = getAuthState();
  // Warm up so the first click on "Sign in"/"Reconnect" opens the popup right away (popups must
  // open during the click, so the script should already be there).
  ensureTokenClient().catch(() => {
    // Offline: retried on the next sign-in attempt.
  });
}

function requestToken(prompt: Prompt): Promise<string> {
  // Coalesce concurrent requests (e.g. several Drive calls hitting 401 at once).
  if (pending) return pending.promise;
  let resolve!: (t: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending = { promise, resolve, reject };
  const open = (client: google.accounts.oauth2.TokenClient) =>
    // `hint` preselects the remembered account: no account chooser, and no consent screen
    // once access was granted, so the popup just flashes and closes.
    client.requestAccessToken({ prompt, ...(account ? { hint: account } : {}) });
  if (tokenClient) open(tokenClient);
  else {
    ensureTokenClient()
      .then(open)
      .catch((err: Error) => {
        pending = null;
        reject(err);
      });
  }
  return promise;
}

/**
 * Interactive sign-in, or "Reconnect" after the session expired. Must be called from a click so
 * the popup isn't blocked. With a remembered account it skips the account chooser.
 */
export function signIn(): Promise<string> {
  return requestToken(account ? '' : 'select_account');
}

/** Signs out and forgets the account on this device. */
export function signOut(): void {
  const current = token;
  account = null;
  storageSet(ACCOUNT_STORAGE_KEY, null);
  setToken(null);
  if (current && typeof google !== 'undefined' && google.accounts?.oauth2) {
    google.accounts.oauth2.revoke(current.accessToken);
  }
}

export function isSignedIn(): boolean {
  return isValid(token);
}

/** Returns a valid access token, trying to renew it when it has expired. */
export async function getAccessToken(): Promise<string> {
  if (isValid(token)) return token.accessToken;
  return refreshAccessToken();
}

/**
 * Tries to get a new token without a click (after a 401 or expiry). Browsers usually block that
 * popup; the session then becomes "expired" (not signed out: data and unsaved changes are kept)
 * until the user taps Reconnect.
 */
export async function refreshAccessToken(): Promise<string> {
  try {
    return await requestToken('');
  } catch {
    setToken(null);
    throw new AuthError('Your Google session expired. Tap "Reconnect" to continue.');
  }
}

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
