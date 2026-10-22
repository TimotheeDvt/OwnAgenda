import ICAL from 'ical.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './helpers';

// In-memory fake of the Drive folder: one calendar file.
const drive = vi.hoisted(() => ({
  content: '',
  modifiedTime: 't1',
  uploads: [] as string[],
  tick: 1,
}));

vi.mock('../src/drive/files', () => ({
  resolvePath: vi.fn(async () => 'folder'),
  listIcsFiles: vi.fn(async () => [
    { id: 'cal-1', name: 'work.ics', modifiedTime: drive.modifiedTime },
  ]),
  downloadFile: vi.fn(async () => drive.content),
  getFileMeta: vi.fn(async () => ({
    id: 'cal-1',
    name: 'work.ics',
    modifiedTime: drive.modifiedTime,
  })),
  uploadFile: vi.fn(async (_id: string, content: string) => {
    drive.uploads.push(content);
    drive.content = content;
    drive.modifiedTime = `t${++drive.tick}`;
    return { id: 'cal-1', name: 'work.ics', modifiedTime: drive.modifiedTime };
  }),
}));

const store = await import('../src/store/calendarStore');

const draft = {
  title: 'Planning',
  allDay: false,
  start: '2025-03-12T10:00:00.000Z',
  end: '2025-03-12T11:00:00.000Z',
};

const range = { start: new Date('2025-03-01'), end: new Date('2025-04-01') };
const allEvents = () => store.eventsInRange(range, () => true);

/** Waits until every queued save has finished. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (store.getCalendarState().saveStatus !== 'saving') return;
  }
}

beforeEach(async () => {
  drive.content = fixture('single-event.ics');
  drive.modifiedTime = 't1';
  drive.uploads = [];
  drive.tick = 1;
  store.setConflictHandler(async () => 'reload');
  await store.loadCalendars('Agendas/ics');
});

describe('calendarStore editing and saving', () => {
  it('saves a new event to Drive and records the new modifiedTime', async () => {
    store.addEvent('cal-1', draft);
    expect(allEvents()).toHaveLength(2);
    await settle();

    expect(drive.uploads).toHaveLength(1);
    expect(drive.uploads[0]).toContain('SUMMARY:Planning');
    const [calendar] = store.getCalendarState().calendars;
    expect(calendar).toMatchObject({ dirty: false, modifiedTime: 't2' });
    expect(store.getCalendarState().saveStatus).toBe('saved');
  });

  it('saves edits made while an upload is in progress', async () => {
    store.addEvent('cal-1', draft);
    store.editEvent('cal-1', 'single-1@test', { ...draft, title: 'Renamed' });
    await settle();

    expect(drive.uploads.at(-1)).toContain('SUMMARY:Renamed');
    expect(store.hasUnsavedChanges()).toBe(false);
  });

  it('deletes events', async () => {
    store.deleteEvent('cal-1', 'single-1@test');
    await settle();
    expect(drive.uploads[0]).not.toContain('single-1@test');
  });

  it('asks on conflict and reloads when chosen', async () => {
    drive.modifiedTime = 'changed-elsewhere';
    const handler = vi.fn(async () => 'reload' as const);
    store.setConflictHandler(handler);

    store.addEvent('cal-1', draft);
    await settle();

    expect(handler).toHaveBeenCalledOnce();
    expect(drive.uploads).toHaveLength(0);
    expect(allEvents().map((e) => e.title)).toEqual(['Project kickoff']);
    expect(store.getCalendarState().calendars[0]?.modifiedTime).toBe('changed-elsewhere');
  });

  it('overwrites on conflict when chosen', async () => {
    drive.modifiedTime = 'changed-elsewhere';
    store.setConflictHandler(async () => 'overwrite');
    store.addEvent('cal-1', draft);
    await settle();
    expect(drive.uploads).toHaveLength(1);
    expect(store.getCalendarState().saveStatus).toBe('saved');
  });

  it('keeps changes unsaved when the decision is postponed', async () => {
    drive.modifiedTime = 'changed-elsewhere';
    store.setConflictHandler(async () => 'later');
    store.addEvent('cal-1', draft);
    await settle();
    expect(drive.uploads).toHaveLength(0);
    expect(store.getCalendarState().saveStatus).toBe('unsaved');
    expect(store.hasUnsavedChanges()).toBe(true);
  });

  it('refuses to edit recurring events', () => {
    const vcal = store.getCalendarState().calendars[0]!.vcalendar;
    vcal
      .getFirstSubcomponent('vevent')!
      .addProperty(ICAL.Property.fromString('RRULE:FREQ=WEEKLY;COUNT=3'));
    expect(() => store.editEvent('cal-1', 'single-1@test', draft)).toThrow(/Recurring/);
    expect(() => store.deleteEvent('cal-1', 'single-1@test')).toThrow(/Recurring/);
  });
});
