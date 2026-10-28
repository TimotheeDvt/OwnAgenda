import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../src/store/settingsStore';
import { exportSettings, importSettings } from '../src/store/settingsTransfer';

const style = (color: string) => ({ color, visible: true, icon: '', textColor: '' });

// Google Drive IDs on one side, Solid URLs (containing "/") on the other.
const DRIVE = [
  { id: 'drive-work', name: 'work.ics' },
  { id: 'drive-family', name: 'family.ics' },
  { id: 'drive-old', name: 'old.ics' },
];
const POD = 'https://alice.pod.test/calendars/';
const SOLID = [
  { id: `${POD}work.ics`, name: 'work.ics' },
  { id: `${POD}family.ics`, name: 'family.ics' },
  { id: `${POD}school.ics`, name: 'school.ics' },
];

function driveSettings(): Settings {
  return {
    ...defaultSettings(),
    folderPath: 'Agendas/ics',
    theme: 'dark',
    corsProxy: 'https://proxy.test/?url={url}',
    calendarOrder: ['drive-family', 'drive-work', 'drive-old'],
    calendars: {
      'drive-work': style('#111111'),
      'drive-family': { ...style('#222222'), icon: '🏠', visible: false },
      'drive-old': style('#333333'),
    },
    ghostEvents: [
      { id: 'drive-work/uid-1', start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z' },
      {
        id: 'drive-family/uid-2/2030-02-01T09:00:00Z',
        start: '2030-02-01T09:00:00Z',
        end: '2030-02-01T10:00:00Z',
      },
    ],
    shownBeforeHideAll: ['drive-work'],
  };
}

/** Export from Drive, then a JSON round trip, like the downloaded file. */
const exported = () =>
  JSON.parse(JSON.stringify(exportSettings(driveSettings(), DRIVE))) as unknown;

describe('settings export', () => {
  it('refers to calendars by file name and leaves the folder out', () => {
    const data = exported() as { settings: Record<string, unknown> };
    expect(data.settings.folderPath).toBeUndefined();
    expect(data.settings.calendarOrder).toEqual(['family.ics', 'work.ics', 'old.ics']);
    expect(Object.keys(data.settings.calendars as object)).toEqual([
      'work.ics',
      'family.ics',
      'old.ics',
    ]);
    expect(JSON.stringify(data)).not.toContain('drive-');
  });
});

describe('settings import', () => {
  const current: Settings = {
    ...defaultSettings(),
    folderPath: 'calendars',
    calendarOrder: [`${POD}school.ics`],
    calendars: { [`${POD}school.ics`]: style('#444444') },
  };

  it('matches calendars by file name and keeps the current folder', () => {
    const { settings, matched, missing } = importSettings(current, exported(), SOLID);
    expect(settings.folderPath).toBe('calendars');
    expect(settings.theme).toBe('dark');
    expect(settings.corsProxy).toBe('https://proxy.test/?url={url}');
    expect(matched).toEqual(['family.ics', 'work.ics']);
    expect(missing).toEqual(['old.ics']);

    expect(settings.calendars[`${POD}family.ics`]).toMatchObject({ icon: '🏠', visible: false });
    expect(settings.calendars[`${POD}work.ics`]?.color).toBe('#111111');
    // Calendars only known here keep their settings and come after the imported order.
    expect(settings.calendars[`${POD}school.ics`]?.color).toBe('#444444');
    expect(settings.calendarOrder).toEqual([
      `${POD}family.ics`,
      `${POD}work.ics`,
      `${POD}school.ics`,
    ]);
    expect(settings.shownBeforeHideAll).toEqual([`${POD}work.ics`]);
  });

  it('moves ghost events to the new file IDs', () => {
    const { settings } = importSettings(current, exported(), SOLID);
    expect(settings.ghostEvents.map((g) => g.id)).toEqual([
      `${POD}work.ics/uid-1`,
      `${POD}family.ics/uid-2/2030-02-01T09:00:00Z`,
    ]);
  });

  it('round-trips between two Solid folders (file IDs with slashes)', () => {
    const solid = importSettings(current, exported(), SOLID).settings;
    const again = exportSettings(solid, SOLID) as { settings: Settings };
    expect(again.settings.ghostEvents.map((g) => g.id)).toEqual([
      'work.ics/uid-1',
      'family.ics/uid-2/2030-02-01T09:00:00Z',
    ]);
  });

  it('refuses files that are not a settings export', () => {
    expect(() => importSettings(current, { theme: 'dark' }, SOLID)).toThrow(
      'not an OwnAgenda settings export',
    );
  });
});
