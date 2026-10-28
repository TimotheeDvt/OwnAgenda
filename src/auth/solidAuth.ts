// Solid sign-in (Solid-OIDC with DPoP tokens, via Inrupt's MIT-licensed browser library).
//
// Unlike Google's popup, signing in is a full-page redirect to the Solid provider and back. The
// library is only downloaded when Solid is used.

import type { EVENTS, Session } from '@inrupt/solid-client-authn-browser';
import { SOLID_CLIENT_NAME } from '../config';
import { parseProfile } from '../storage/solid/rdf';
import { AuthError, storageGet, storageSet, type AuthListener, type AuthState } from './types';

const WEBID_STORAGE_KEY = 'ics-agenda.solid.webId';
const ISSUER_STORAGE_KEY = 'ics-agenda.solid.issuer';

/** Errors returned by a silent session restore that just mean "sign in again". */
const SILENT_LOGIN_ERRORS = new Set(['login_required', 'interaction_required', 'consent_required']);
/** Query parameters the provider adds when redirecting back to the app. */
const REDIRECT_PARAMS = ['code', 'state', 'iss', 'error', 'error_description'];

/**
 * The library renews the access token on a timer shortly before it expires, and only then. In a
 * background tab or after the computer slept, that timer runs late: requests sent in the
 * meantime would use the expired token and get a 401. They wait this long for the renewal.
 */
const RENEWAL_WAIT_MS = 10_000;
/** Treat the token as expired this long before its expiration date. */
const EXPIRY_MARGIN_MS = 5_000;

let session: Session | null = null;
let renewedEvent: (typeof EVENTS)['SESSION_EXTENDED'] = 'sessionExtended';
let signedIn = false;
let webId: string | null = null;
let redirectError: string | null = null;
let lastState: AuthState = 'signedOut';
const listeners = new Set<AuthListener>();

export function getSolidAuthState(): AuthState {
  if (signedIn) return 'signedIn';
  return webId ? 'expired' : 'signedOut';
}

function emitIfChanged(): void {
  const state = getSolidAuthState();
  if (state === lastState) return;
  lastState = state;
  listeners.forEach((l) => l(state));
}

async function getSession(): Promise<Session> {
  if (session) return session;
  const { Session: SessionClass, EVENTS } = await import('@inrupt/solid-client-authn-browser');
  session = new SessionClass();
  renewedEvent = EVENTS.SESSION_EXTENDED;
  session.events.on(EVENTS.SESSION_EXPIRED, () => markSolidSessionExpired());
  // A renewal that arrives after the app gave up (read-only, "Reconnect"): back to normal.
  session.events.on(EVENTS.SESSION_EXTENDED, () => {
    if (!signedIn && webId && session?.info.isLoggedIn) {
      signedIn = true;
      emitIfChanged();
    }
  });
  return session;
}

function tokenIsStale(s: Session): boolean {
  const expires = s.info.expirationDate;
  return typeof expires === 'number' && Date.now() >= expires - EXPIRY_MARGIN_MS;
}

/** Resolves when the library renewed the token, or after RENEWAL_WAIT_MS. */
function waitForRenewal(s: Session): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      s.events.off(renewedEvent, done);
      resolve();
    };
    const timer = setTimeout(done, RENEWAL_WAIT_MS);
    s.events.once(renewedEvent, done);
  });
}

/** The app's own URL, where the provider sends the user back (no query or hash). */
function appUrl(): string {
  return `${location.origin}${location.pathname}`;
}

/** True when the page was opened by the Solid provider redirecting back after sign-in. */
export function isSolidRedirect(): boolean {
  const params = new URLSearchParams(location.search);
  return params.has('state') && (params.has('code') || params.has('error'));
}

function cleanRedirectUrl(): void {
  const url = new URL(location.href);
  for (const name of REDIRECT_PARAMS) url.searchParams.delete(name);
  history.replaceState(null, '', url);
}

/**
 * Finishes a sign-in redirect, or (with `restore`) renews the previous session: that is a quick
 * silent redirect to the provider and back, so it is skipped when offline (the app then opens
 * read-only from its offline copy).
 */
export async function initSolidAuth(restore: boolean): Promise<void> {
  webId = storageGet(WEBID_STORAGE_KEY);
  const fromRedirect = isSolidRedirect();
  if (fromRedirect) {
    const params = new URLSearchParams(location.search);
    const error = params.get('error');
    if (error && !SILENT_LOGIN_ERRORS.has(error)) {
      redirectError = params.get('error_description') || `Solid sign-in failed (${error}).`;
    }
  }
  if (fromRedirect || (restore && webId && navigator.onLine)) {
    try {
      const s = await getSession();
      // Never resolves when it starts a silent redirect: the page is about to be replaced.
      await s.handleIncomingRedirect({ restorePreviousSession: !fromRedirect });
      if (s.info.isLoggedIn && s.info.webId) {
        signedIn = true;
        webId = s.info.webId;
        storageSet(WEBID_STORAGE_KEY, webId);
      }
    } catch (err) {
      // Provider unreachable or a broken redirect: stay signed out / expired.
      if (fromRedirect) redirectError = err instanceof Error ? err.message : String(err);
    } finally {
      if (fromRedirect) cleanRedirectUrl();
    }
  }
  lastState = getSolidAuthState();
}

/** Error from the sign-in redirect that just completed, once (to show it to the user). */
export function takeSolidRedirectError(): string | null {
  const error = redirectError;
  redirectError = null;
  return error;
}

/** Turns what the user typed (provider or WebID, with or without https://) into a URL. */
function normalizeUrl(input: string): URL {
  const trimmed = input.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new AuthError(`"${trimmed}" is not a valid address.`);
  }
}

/**
 * The OpenID provider for what the user typed: a provider address is used as is, a WebID
 * (e.g. https://name.solidcommunity.net/profile/card#me) is looked up in its profile.
 */
async function resolveIssuer(input: string): Promise<string> {
  const url = normalizeUrl(input);
  if (!url.hash && url.pathname === '/') return url.origin;
  let issuer: string | null = null;
  try {
    const res = await fetch(url.href, { headers: { Accept: 'text/turtle' } });
    if (res.ok) issuer = parseProfile(url.href, await res.text()).issuer;
  } catch {
    // Reported below.
  }
  if (!issuer) {
    throw new AuthError(`No Solid provider found in the profile at ${url.href}.`);
  }
  return issuer.replace(/\/$/, '');
}

/** The provider used last on this device, to prefill the sign-in form. */
export function lastSolidIssuer(): string | null {
  return storageGet(ISSUER_STORAGE_KEY);
}

/**
 * Redirects to the Solid provider to sign in (or reconnect, with no argument: the provider used
 * last). The page is replaced, so unsaved changes must be dealt with before calling this.
 */
export async function signInSolid(providerOrWebId?: string): Promise<void> {
  const input = providerOrWebId ?? lastSolidIssuer();
  if (!input) throw new AuthError('Enter your Solid provider to sign in.');
  const issuer = await resolveIssuer(input);
  storageSet(ISSUER_STORAGE_KEY, issuer);
  const s = await getSession();
  await s.login({ oidcIssuer: issuer, redirectUrl: appUrl(), clientName: SOLID_CLIENT_NAME });
}

/** Signs out of this app (not of the provider) and forgets the account on this device. */
export function signOutSolid(): void {
  const s = session;
  signedIn = false;
  webId = null;
  storageSet(WEBID_STORAGE_KEY, null);
  emitIfChanged();
  if (s) void s.logout({ logoutType: 'app' }).catch(() => {});
}

/** The session ran out, or the pod rejected the token: read-only until "Reconnect". */
export function markSolidSessionExpired(): void {
  signedIn = false;
  emitIfChanged();
}

export function rememberedSolidAccount(): string | null {
  return webId;
}

/**
 * fetch() that sends the Solid session's tokens. When the token is past its expiration (its
 * renewal is running late) or the pod answers 401, it waits for the renewal and tries once more:
 * only a 401 after that means the session is really over.
 */
export async function solidFetch(input: string, init?: RequestInit): Promise<Response> {
  const s = session;
  if (!s || !signedIn) {
    throw new AuthError('Your Solid session expired. Tap "Reconnect" to continue.');
  }
  if (tokenIsStale(s)) await waitForRenewal(s);
  const res = await s.fetch(input, init);
  if (res.status !== 401 || !tokenIsStale(s)) return res;
  await waitForRenewal(s);
  return s.fetch(input, init);
}

export function onSolidAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
