import ICAL from 'ical.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageProvider } from '../src/storage';
import { FakeStorage } from './fakeStorage';
import { fixture } from './helpers';

// The store runs against an in-memory StorageProvider (no Drive, no network).
const fake = new FakeStorage();
setStorageProvider(fake);
/** The test calendar file. */
const calFile = () => fake.files.get('cal-1')!;

const store = await import('../src/store/calendarStore');

const draft = {
  title: 'Planning',
  allDay: false,
  start: '2025-03-12T10:00:00.000Z',
  end: '2025-03-12T11:00:00.000Z',
};

const range = { start: new Date('2025-03-01'), end: new Date('2025-04-01') };
const allEvents = () => store.eventsInRange(range, () => true);
const eventByUid = (uid: string) => allEvents().find((e) => e.uid === uid)!;

/** Waits until every queued save has finished. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (store.getCalendarState().saveStatus !== 'saving') return;
  }
}

beforeEach(async () => {
  fake.reset();
  fake.put('cal-1', 'work.ics', fixture('single-event.ics'));
  store.clearCalendars();
  store.setConflictHandler(async () => 'reload');
  await store.loadCalendars('Agendas/ics');
});

describe('calendarStore editing and saving', () => {
  it('saves a new event to Drive and records the new modifiedTime', async () => {
    store.addEvent('cal-1', draft);
    expect(allEvents()).toHaveLength(2);
    await settle();

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]).toContain('SUMMARY:Planning');
    const [calendar] = store.getCalendarState().calendars;
    expect(calendar).toMatchObject({ dirty: false, modifiedTime: 't2' });
    expect(store.getCalendarState().saveStatus).toBe('saved');
  });

  it('saves edits made while an upload is in progress', async () => {
    store.addEvent('cal-1', draft);
    store.editEvent(eventByUid('single-1@test'), { ...draft, title: 'Renamed' });
    await settle();

    expect(fake.uploads.at(-1)).toContain('SUMMARY:Renamed');
    expect(store.hasUnsavedChanges()).toBe(false);
  });

  it('deletes events', async () => {
    store.deleteEvent(eventByUid('single-1@test'));
    await settle();
    expect(fake.uploads[0]).not.toContain('single-1@test');
  });

  it('asks on conflict and reloads when chosen', async () => {
    calFile().modifiedTime = 'changed-elsewhere';
    const handler = vi.fn(async () => 'reload' as const);
    store.setConflictHandler(handler);

    store.addEvent('cal-1', draft);
    await settle();

    expect(handler).toHaveBeenCalledOnce();
    expect(fake.uploads).toHaveLength(0);
    expect(allEvents().map((e) => e.title)).toEqual(['Project kickoff']);
    expect(store.getCalendarState().calendars[0]?.modifiedTime).toBe('changed-elsewhere');
  });

  it('overwrites on conflict when chosen', async () => {
    calFile().modifiedTime = 'changed-elsewhere';
    store.setConflictHandler(async () => 'overwrite');
    store.addEvent('cal-1', draft);
    await settle();
    expect(fake.uploads).toHaveLength(1);
    expect(store.getCalendarState().saveStatus).toBe('saved');
  });

  it('keeps changes unsaved when the decision is postponed', async () => {
    calFile().modifiedTime = 'changed-elsewhere';
    store.setConflictHandler(async () => 'later');
    store.addEvent('cal-1', draft);
    await settle();
    expect(fake.uploads).toHaveLength(0);
    expect(store.getCalendarState().saveStatus).toBe('unsaved');
    expect(store.hasUnsavedChanges()).toBe(true);
  });
});

describe('recurring events in the store', () => {
  beforeEach(() => {
    const vcal = store.getCalendarState().calendars[0]!.vcalendar;
    vcal
      .getFirstSubcomponent('vevent')!
      .addProperty(ICAL.Property.fromString('RRULE:FREQ=WEEKLY;COUNT=3'));
  });

  it('edits only this occurrence', async () => {
    const [, second] = allEvents();
    expect(second?.recurring).toBe(true);
    store.editEvent(second!, { ...store.eventToDraft(second!), title: 'Moved' }, { scope: 'this' });
    await settle();
    expect(fake.uploads[0]).toContain('RECURRENCE-ID:20250317T140000Z');
    expect(allEvents().map((e) => e.title)).toEqual([
      'Project kickoff',
      'Moved',
      'Project kickoff',
    ]);
  });

  it('deletes this and following occurrences', () => {
    const [, second] = allEvents();
    store.deleteEvent(second!, 'following');
    expect(allEvents()).toHaveLength(1);
  });

  it('reports the series rule', () => {
    expect(store.ruleOfEvent(allEvents()[0]!).rule).toMatchObject({
      freq: 'WEEKLY',
      end: { type: 'count', count: 3 },
    });
  });
});

describe('refresh, calendars and search', () => {
  it('refreshes one calendar from Drive and reports whether it changed', async () => {
    expect(await store.refreshCalendar('cal-1')).toBe('unchanged');
    fake.put('cal-1', 'work.ics', fixture('weekly-exdate.ics'), 't9');
    expect(await store.refreshCalendar('cal-1')).toBe('updated');
    expect(store.getCalendarState().refreshing).toEqual([]);
    expect(
      store.eventsInRange(
        { start: new Date('2025-01-01'), end: new Date('2025-03-01') },
        () => true,
      ),
    ).toHaveLength(5);
  });

  it('creates a calendar file with a unique name', async () => {
    await store.createCalendar('work');
    expect(fake.files.get('file-2')?.name).toBe('work (2).ics');
    expect(fake.files.get('file-2')?.content).toContain('X-WR-CALNAME:work');
    expect(store.getCalendarState().calendars.map((c) => c.displayName)).toContain('work');
  });

  it('renames a calendar through X-WR-CALNAME', async () => {
    store.renameCalendar('cal-1', 'Office');
    await settle();
    expect(store.getCalendarState().calendars[0]?.displayName).toBe('Office');
    expect(fake.uploads[0]).toContain('X-WR-CALNAME:Office');
  });

  it('searches titles, locations and descriptions', () => {
    const now = new Date('2025-03-01');
    expect(store.searchEvents('kickoff', now).map((e) => e.uid)).toEqual(['single-1@test']);
    expect(store.searchEvents('room 4', now)).toHaveLength(1);
    expect(store.searchEvents('slides bring', now)).toHaveLength(1);
    expect(store.searchEvents('nothing like this', now)).toHaveLength(0);
  });

  it('lists a recurring series once in search results', () => {
    const vcal = store.getCalendarState().calendars[0]!.vcalendar;
    vcal
      .getFirstSubcomponent('vevent')!
      .addProperty(ICAL.Property.fromString('RRULE:FREQ=DAILY;COUNT=30'));
    const [result, ...rest] = store.searchEvents('kickoff', new Date('2025-03-20T00:00:00Z'));
    expect(rest).toHaveLength(0);
    expect(result?.startInput).toBe('2025-03-20T14:00:00.000Z');
  });
});

describe('offline copy', () => {
  it('keeps showing cached calendars when Drive is unreachable', async () => {
    store.clearCalendars();
    store.loadFromCache([
      {
        meta: { id: 'cal-1', name: 'work.ics', modifiedTime: 't1' },
        content: fixture('single-event.ics'),
      },
    ]);
    expect(store.getCalendarState().fromCache).toBe(true);
    fake.offline = true;
    await store.loadCalendars('Agendas/ics');
    const state = store.getCalendarState();
    expect(state.status).toBe('ready');
    expect(state.calendars).toHaveLength(1);
    expect(state.warnings[0]).toMatch(/copy saved on this device/);
    expect(store.snapshotFiles()).toBeNull();
  });

  it('snapshots the Drive state when everything is saved', () => {
    const files = store.snapshotFiles();
    expect(files).toHaveLength(1);
    expect(files![0]!.content).toContain('UID:single-1@test');
    store.addEvent('cal-1', draft);
    expect(store.snapshotFiles()).toBeNull();
  });
});

describe('read-only mode (offline / session expired)', () => {
  it('refuses changes while read-only', () => {
    store.setReadOnly('offline');
    expect(() => store.addEvent('cal-1', draft)).toThrow(/offline/);
    expect(() => store.editEvent(eventByUid('single-1@test'), draft)).toThrow(/offline/);
    expect(() => store.deleteEvent(eventByUid('single-1@test'))).toThrow(/offline/);
    expect(() => store.renameCalendar('cal-1', 'x')).toThrow(/offline/);
    store.setReadOnly(null);
  });

  it('keeps a change made just before the session expired, and saves it after reconnecting', async () => {
    // The change is made, but its save fails because the session just expired.
    fake.uploadError = new Error('Your Google session expired.');
    store.addEvent('cal-1', draft);
    await settle();
    store.setReadOnly('expired');
    expect(store.hasUnsavedChanges()).toBe(true);
    expect(store.getCalendarState().readOnly).toBe('expired');

    // Reconnected: the waiting change is saved.
    fake.uploadError = null;
    store.setReadOnly(null);
    await settle();
    expect(fake.uploads.at(-1)).toContain('SUMMARY:Planning');
    expect(store.hasUnsavedChanges()).toBe(false);
  });

  it('becomes read-only when storage is unreachable and the offline copy is shown', async () => {
    store.clearCalendars();
    store.loadFromCache([
      {
        meta: { id: 'cal-1', name: 'work.ics', modifiedTime: 't1' },
        content: fixture('single-event.ics'),
      },
    ]);
    fake.offline = true;
    await store.loadCalendars('Agendas/ics');
    expect(store.getCalendarState().readOnly).toBe('offline');

    fake.offline = false;
    await store.loadCalendars('Agendas/ics');
    expect(store.getCalendarState().readOnly).toBeNull();
  });
});
