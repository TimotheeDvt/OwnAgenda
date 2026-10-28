// Sign-in for the storage the user chose: Google Drive (googleAuth.ts) or a Solid pod
// (solidAuth.ts). The rest of the app only uses this module, whatever the storage is.

import { GOOGLE_CLIENT_ID } from '../config';
import { setStorageProvider } from '../storage';
import { googleDriveProvider } from '../storage/googleDrive';
import { solidProvider } from '../storage/solid';
import * as google from './googleAuth';
import * as solid from './solidAuth';
import { storageGet, storageSet, type AuthListener, type AuthState } from './types';

export { AuthError, type AuthListener, type AuthState } from './types';

export type SignInMethod = 'google-drive' | 'solid';

const METHOD_STORAGE_KEY = 'ics-agenda.provider';

let method: SignInMethod | null = null;
let lastState: AuthState = 'signedOut';
const listeners = new Set<AuthListener>();

/** Google sign-in needs an OAuth client ID at build time; Solid needs nothing. */
export function isGoogleAvailable(): boolean {
  return !!GOOGLE_CLIENT_ID;
}

function setMethod(next: SignInMethod | null): void {
  method = next;
  storageSet(METHOD_STORAGE_KEY, next);
  if (next) setStorageProvider(next === 'solid' ? solidProvider : googleDriveProvider);
}

export function getSignInMethod(): SignInMethod | null {
  return method;
}

export function getAuthState(): AuthState {
  if (method === 'solid') return solid.getSolidAuthState();
  if (method === 'google-drive') return google.getAuthState();
  return 'signedOut';
}

function emitIfChanged(): void {
  const state = getAuthState();
  if (state === lastState) return;
  lastState = state;
  listeners.forEach((l) => l(state));
}

function storedMethod(): SignInMethod | null {
  const stored = storageGet(METHOD_STORAGE_KEY);
  if (stored === 'solid') return 'solid';
  if (!isGoogleAvailable()) return null;
  if (stored === 'google-drive') return 'google-drive';
  // Signed in before Solid support existed: that was Google.
  return google.rememberedAccount() ? 'google-drive' : null;
}

/**
 * Restores the session of the storage used last on this device. Google never needs the
 * network here; Solid completes a sign-in redirect, or renews the session when online.
 */
export async function initAuth(): Promise<void> {
  if (isGoogleAvailable()) google.initAuth();
  // Coming back from the Solid provider wins over whatever was used before.
  setMethod(solid.isSolidRedirect() ? 'solid' : storedMethod());
  await solid.initSolidAuth(method === 'solid');
  // A finished Solid redirect that failed leaves nobody signed in.
  if (method === 'solid' && solid.getSolidAuthState() === 'signedOut') setMethod(null);
  lastState = getAuthState();
  google.onAuthChange(() => {
    if (method === 'google-drive') emitIfChanged();
  });
  solid.onSolidAuthChange(() => {
    if (method === 'solid') emitIfChanged();
  });
}

/** Error of a Solid sign-in redirect that just failed, to show once. */
export function takeSignInError(): string | null {
  return solid.takeSolidRedirectError();
}

/** True when signing in replaces the page (Solid): unsaved changes must be handled first. */
export function signInRedirects(next: SignInMethod | null = method): boolean {
  return next === 'solid';
}

/**
 * Interactive sign-in with `options.method`, or "Reconnect" with the current one. For Google it
 * must be called from a click (popup), with nothing awaited before. For Solid, `options.provider`
 * is the provider or WebID typed by the user (default: the one used last).
 */
export async function signIn(
  options: { method?: SignInMethod; provider?: string } = {},
): Promise<void> {
  const next = options.method ?? method ?? 'google-drive';
  if (next !== method) setMethod(next);
  if (next === 'solid') await solid.signInSolid(options.provider);
  else await google.signIn();
}

/** The Solid provider used last on this device, to prefill the sign-in form. */
export function lastSolidProvider(): string | null {
  return solid.lastSolidIssuer();
}

/** Signs out and forgets the account on this device. */
export function signOut(): void {
  if (method === 'solid') solid.signOutSolid();
  else if (method === 'google-drive') google.signOut();
  storageSet(METHOD_STORAGE_KEY, null);
  method = null;
  emitIfChanged();
}

/** Remembers the account in use (Google: skips the account chooser on later sign-ins). */
export function rememberAccount(email: string): void {
  if (method === 'google-drive') google.rememberAccount(email);
}

export function rememberedAccount(): string | null {
  if (method === 'solid') return solid.rememberedSolidAccount();
  if (method === 'google-drive') return google.rememberedAccount();
  return null;
}

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
