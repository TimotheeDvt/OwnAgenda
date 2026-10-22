import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/store/settingsStore';

describe('normalizeSettings', () => {
  it('returns defaults for missing or invalid input', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    expect(normalizeSettings('nope')).toEqual(defaultSettings());
  });

  it('keeps valid fields and fills missing ones', () => {
    const s = normalizeSettings({
      folderPath: ' Agendas/ics ',
      defaultView: 'dayGridMonth',
      timeZone: 'Europe/Paris',
      calendars: { abc: { color: '#ff0000', visible: false } },
    });
    expect(s).toMatchObject({
      version: 1,
      folderPath: 'Agendas/ics',
      defaultView: 'dayGridMonth',
      weekStartsOn: 1,
      timeZone: 'Europe/Paris',
      theme: 'system',
      calendars: { abc: { color: '#ff0000', visible: false } },
    });
  });

  it('replaces invalid values with defaults', () => {
    const s = normalizeSettings({
      defaultView: 'yearView',
      weekStartsOn: 9,
      timeZone: 'Mars/Olympus',
      theme: 'neon',
      calendars: { abc: { color: 'red', visible: 'yes' }, bad: 42 },
    });
    const d = defaultSettings();
    expect(s.defaultView).toBe(d.defaultView);
    expect(s.weekStartsOn).toBe(d.weekStartsOn);
    expect(s.timeZone).toBe(d.timeZone);
    expect(s.theme).toBe(d.theme);
    expect(s.calendars).toEqual({ abc: { color: '', visible: true } });
  });

  it('preserves unknown fields so newer settings are not lost', () => {
    const s = normalizeSettings({ futureOption: 42 }) as unknown as Record<string, unknown>;
    expect(s.futureOption).toBe(42);
  });
});
