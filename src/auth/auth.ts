import { GIS_SCRIPT_URL, GOOGLE_CLIENT_ID, SCOPES, TOKEN_EXPIRY_MARGIN_MS } from '../config';

type Prompt = '' | 'consent' | 'select_account';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

export type AuthListener = (signedIn: boolean) => void;

const TOKEN_STORAGE_KEY = 'ics-agenda.token';

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let token: StoredToken | null = null;
let pending: {
  promise: Promise<string>;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
} | null = null;
const listeners = new Set<AuthListener>();

export class AuthError extends Error {
  override name = 'AuthError';
}

function loadGisScript(): Promise<void> {
  if (typeof google !== 'undefined' && google.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new AuthError('Could not load Google Identity Services.'));
    document.head.appendChild(script);
  });
}

function readStoredToken(): StoredToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    return typeof parsed.accessToken === 'string' && typeof parsed.expiresAt === 'number'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeStoredToken(value: StoredToken | null): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked cookies): the token just won't survive a reload.
  }
}

function isValid(t: StoredToken | null): t is StoredToken {
  return !!t && t.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now();
}

function setToken(value: StoredToken | null): void {
  const wasSignedIn = token !== null;
  token = value;
  writeStoredToken(value);
  if (wasSignedIn !== (value !== null)) listeners.forEach((l) => l(value !== null));
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

/** Loads GIS and restores a still-valid token from this browser session. Call once at startup. */
export async function initAuth(): Promise<void> {
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
  const stored = readStoredToken();
  if (isValid(stored)) setToken(stored);
  else writeStoredToken(null);
}

function requestToken(prompt: Prompt): Promise<string> {
  if (!tokenClient) return Promise.reject(new AuthError('Auth is not initialized.'));
  // Coalesce concurrent requests (e.g. several Drive calls hitting 401 at once).
  if (pending) return pending.promise;
  let resolve!: (t: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending = { promise, resolve, reject };
  tokenClient.requestAccessToken({ prompt });
  return promise;
}

/** Interactive sign-in. Must be called from a user gesture (click) so the popup isn't blocked. */
export function signIn(): Promise<string> {
  return requestToken('select_account');
}

export function signOut(): void {
  const current = token;
  setToken(null);
  if (current && typeof google !== 'undefined') google.accounts.oauth2.revoke(current.accessToken);
}

export function isSignedIn(): boolean {
  return isValid(token);
}

/** Returns a valid access token, silently re-requesting one when it has expired. */
export async function getAccessToken(): Promise<string> {
  if (isValid(token)) return token.accessToken;
  return refreshAccessToken();
}

/** Forces a new token (used after a 401). Signs out if it cannot be obtained. */
export async function refreshAccessToken(): Promise<string> {
  try {
    return await requestToken('');
  } catch (err) {
    setToken(null);
    throw err;
  }
}

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
