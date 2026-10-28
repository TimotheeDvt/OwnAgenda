import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The library's Session, faked: tokens and renewals are driven by the tests.
class FakeSession {
  static current: FakeSession;
  events = new EventEmitter();
  info = { isLoggedIn: false, webId: undefined as string | undefined, expirationDate: 0 };
  /** Whether the pod accepts the current token. */
  tokenValid = true;
  fetch = vi.fn(async () => new Response('', { status: this.tokenValid ? 200 : 401 }));
  constructor() {
    FakeSession.current = this;
  }
  async handleIncomingRedirect() {
    this.info = {
      isLoggedIn: true,
      webId: 'https://alice.pod.test/profile/card#me',
      expirationDate: Date.now() + 60_000,
    };
    return this.info;
  }
  /** What the library's (late) renewal timer does. */
  renew() {
    this.tokenValid = true;
    this.info.expirationDate = Date.now() + 60_000;
    this.events.emit('sessionExtended', 60);
  }
}

vi.mock('@inrupt/solid-client-authn-browser', () => ({
  Session: FakeSession,
  EVENTS: { SESSION_EXPIRED: 'sessionExpired', SESSION_EXTENDED: 'sessionExtended' },
}));

const auth = await import('../src/auth/solidAuth');

/** Signs in through a fake redirect back from the provider. */
async function signIn(): Promise<FakeSession> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('location', {
    href: 'https://app.test/?code=c&state=s',
    search: '?code=c&state=s',
    origin: 'https://app.test',
    pathname: '/',
  });
  vi.stubGlobal('history', { replaceState: () => {} });
  await auth.initSolidAuth(false);
  return FakeSession.current;
}

describe('Solid session renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for a late renewal instead of sending an expired token', async () => {
    const session = await signIn();
    expect(auth.getSolidAuthState()).toBe('signedIn');
    // The computer slept: the token is past its expiration, the renewal timer hasn't run yet.
    session.info.expirationDate = Date.now() - 1000;
    session.tokenValid = false;

    const request = auth.solidFetch('https://alice.pod.test/calendars/');
    await vi.advanceTimersByTimeAsync(100);
    expect(session.fetch).not.toHaveBeenCalled();
    session.renew();

    expect((await request).status).toBe(200);
    expect(session.fetch).toHaveBeenCalledTimes(1);
    expect(auth.getSolidAuthState()).toBe('signedIn');
  });

  it('returns a 401 right away while the token is still fresh', async () => {
    const session = await signIn();
    session.tokenValid = false;
    expect((await auth.solidFetch('https://alice.pod.test/x')).status).toBe(401);
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });

  it('gets back to normal when a renewal arrives after the session was marked expired', async () => {
    const session = await signIn();
    const states: string[] = [];
    auth.onSolidAuthChange((s) => states.push(s));
    auth.markSolidSessionExpired();
    session.renew();
    expect(states).toEqual(['expired', 'signedIn']);
  });
});
