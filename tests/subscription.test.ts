import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSubscriptionCalendar,
  isStale,
  normalizeSubscriptionUrl,
  subscriptionInfo,
} from '../src/ics/subscription';
import { serializeCalendar } from '../src/ics/serialize';
import { applyProxy, fetchRemoteCalendar } from '../src/net/remoteCalendar';
import { setStorageProvider } from '../src/storage';
import { FakeStorage } from './fakeStorage';
import { fixture } from './helpers';

const URL_ = 'https://ade.example.fr/anonymous_cal.jsp?resources=123&projectId=8';
const NOW = new Date('2025-03-10T08:00:00Z');

describe('subscription metadata', () => {
  it('stores the source URL, download time and our name in the calendar', () => {
    const vcal = buildSubscriptionCalendar(fixture('single-event.ics'), URL_, 'AMU lessons', NOW);
    const text = serializeCalendar(vcal);
    expect(text).toContain('X-WR-CALNAME:AMU lessons');
    expect(text).toContain('X-OWNAGENDA-LAST-UPDATE:2025-03-10T08:00:00.000Z');
    expect(subscriptionInfo(vcal)).toEqual({ url: URL_, lastUpdate: NOW });
    // Events of the online calendar are kept as they are.
    expect(text).toContain('UID:single-1@test');
  });

  it('survives a save and reload (long URLs are folded and unfolded)', async () => {
    const { parseIcs } = await import('../src/ics/parse');
    const long = `${URL_}&${'x'.repeat(120)}`;
    const vcal = buildSubscriptionCalendar(fixture('single-event.ics'), long, 'AMU', NOW);
    expect(subscriptionInfo(parseIcs(serializeCalendar(vcal)))?.url).toBe(long);
  });

  it('is not a subscription without a source URL', async () => {
    const { parseIcs } = await import('../src/ics/parse');
    expect(subscriptionInfo(parseIcs(fixture('single-event.ics')))).toBeNull();
  });

  it('is stale after a day, or when the update time is missing', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(isStale({ url: URL_, lastUpdate: new Date(NOW.getTime() - day + 60_000) }, NOW)).toBe(
      false,
    );
    expect(isStale({ url: URL_, lastUpdate: new Date(NOW.getTime() - day - 60_000) }, NOW)).toBe(
      true,
    );
    expect(isStale({ url: URL_, lastUpdate: null }, NOW)).toBe(true);
  });

  it('accepts https and webcal links only', () => {
    expect(normalizeSubscriptionUrl(' webcal://cal.example.com/a.ics ')).toBe(
      'https://cal.example.com/a.ics',
    );
    expect(() => normalizeSubscriptionUrl('ftp://x/y.ics')).toThrow(/https/);
    expect(() => normalizeSubscriptionUrl('not a link')).toThrow(/valid/);
  });
});

describe('fetchRemoteCalendar', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies the proxy template', () => {
    expect(applyProxy('https://a.b/c?d=1', 'https://p.example/?url={url}')).toBe(
      'https://p.example/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1',
    );
    expect(applyProxy('https://a.b/c', '')).toBe('https://a.b/c');
  });

  it('returns the calendar text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(fixture('single-event.ics'))),
    );
    expect(await fetchRemoteCalendar(URL_)).toContain('BEGIN:VCALENDAR');
  });

  it('explains CORS failures and rejects non-calendar answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchRemoteCalendar(URL_)).rejects.toThrow(/CORS/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Login</html>')),
    );
    await expect(fetchRemoteCalendar(URL_)).rejects.toThrow(/iCalendar/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    await expect(fetchRemoteCalendar(URL_)).rejects.toThrow(/404/);
  });
});

// Store: subscribe, daily update, read-only

// The store runs against an in-memory StorageProvider (no Drive, no network).
const fake = new FakeStorage();
setStorageProvider(fake);

const store = await import('../src/store/calendarStore');

async function settle() {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const s = store.getCalendarState();
    if (s.saveStatus !== 'saving' && s.refreshing.length === 0) return;
  }
}

describe('subscribed calendars in the store', () => {
  let remote = '';

  beforeEach(async () => {
    fake.reset();
    remote = fixture('single-event.ics');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(remote)),
    );
    store.clearCalendars();
    await store.loadCalendars('Agendas/ics');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes: downloads the calendar and saves it as a new file', async () => {
    const id = await store.subscribeCalendar('AMU lessons', 'webcal://ade.example.fr/cal.ics');
    const file = fake.files.get(id)!;
    expect(file.name).toBe('AMU lessons.ics');
    expect(file.content).toContain('X-OWNAGENDA-SOURCE-URL:https://ade.example.fr/cal.ics');
    expect(store.subscriptionOf(id)?.url).toBe('https://ade.example.fr/cal.ics');
  });

  it('refuses to edit events of a subscribed calendar', async () => {
    const id = await store.subscribeCalendar('AMU', 'https://ade.example.fr/cal.ics');
    const [event] = store.eventsInRange(
      { start: new Date('2025-03-01'), end: new Date('2025-04-01') },
      (c) => c.fileId === id,
    );
    expect(() => store.deleteEvent(event!)).toThrow(/subscribed/);
    expect(() =>
      store.addEvent(id, { title: 'x', allDay: true, start: '2025-03-01', end: '2025-03-02' }),
    ).toThrow(/subscribed/);
  });

  it('updates a copy older than a day when the folder loads, keeping the name', async () => {
    const stale = buildSubscriptionCalendar(
      fixture('single-event.ics'),
      URL_,
      'Renamed by me',
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    );
    fake.files.set('sub', {
      name: 'amu.ics',
      content: serializeCalendar(stale),
      modifiedTime: 't1',
    });
    remote = fixture('weekly-exdate.ics');

    await store.loadCalendars('Agendas/ics');
    await settle();

    const saved = fake.files.get('sub')!.content;
    expect(saved).toContain('UID:weekly-1@test'); // new content from the online calendar
    expect(saved).toContain('X-WR-CALNAME:Renamed by me');
    const info = store.subscriptionOf('sub')!;
    expect(Date.now() - info.lastUpdate!.getTime()).toBeLessThan(60_000);
  });

  it('leaves a fresh copy alone unless forced', async () => {
    const fresh = buildSubscriptionCalendar(fixture('single-event.ics'), URL_, 'AMU', new Date());
    fake.files.set('sub', {
      name: 'amu.ics',
      content: serializeCalendar(fresh),
      modifiedTime: 't1',
    });
    await store.loadCalendars('Agendas/ics');
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    remote = fixture('weekly-exdate.ics');
    expect(await store.syncSubscription('sub', { force: true })).toBe('updated');
    await settle();
    expect(fake.files.get('sub')!.content).toContain('UID:weekly-1@test');
  });
});
