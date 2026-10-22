import { describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  effectiveTextColor,
  getSettings,
  moveCalendar,
  normalizeIcon,
  normalizeSettings,
  orderCalendars,
  resetSettings,
  updateSettings,
} from '../src/store/settingsStore';

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
    expect(s.calendars).toEqual({ abc: { color: '', visible: true, icon: '', textColor: '' } });
  });

  it('preserves unknown fields so newer settings are not lost', () => {
    const s = normalizeSettings({ futureOption: 42 }) as unknown as Record<string, unknown>;
    expect(s.futureOption).toBe(42);
  });
});

describe('calendar order', () => {
  const cal = (fileId: string) => ({ fileId });
  const ids = (list: { fileId: string }[]) => list.map((c) => c.fileId);

  it('sorts by the saved order, with unknown calendars after in their original order', () => {
    const list = [cal('a'), cal('b'), cal('c'), cal('d')];
    expect(ids(orderCalendars(list, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(orderCalendars(list, []))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(orderCalendars(list, ['gone', 'd']))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves a calendar and keeps hidden ones at the end of the saved order', () => {
    vi.useFakeTimers();
    try {
      resetSettings();
      updateSettings({ calendarOrder: ['x', 'a', 'b'] });
      moveCalendar(['a', 'b', 'c'], 2, 0);
      expect(getSettings().calendarOrder).toEqual(['c', 'a', 'b', 'x']);
      moveCalendar(['c', 'a', 'b'], 0, 2);
      expect(getSettings().calendarOrder).toEqual(['a', 'b', 'c', 'x']);
    } finally {
      resetSettings();
      vi.useRealTimers();
    }
  });

  it('normalizes the saved order', () => {
    expect(normalizeSettings({ calendarOrder: ['a', 1, 'a', 'b'] }).calendarOrder).toEqual([
      'a',
      'b',
    ]);
    expect(normalizeSettings({ calendarOrder: 'nope' }).calendarOrder).toEqual([]);
  });
});

describe('ghost events', () => {
  it('normalizes the saved list', () => {
    const ghost = { id: 'f/a', start: '2026-10-22T08:00:00Z', end: '2026-10-22T09:00:00Z' };
    expect(
      normalizeSettings({
        ghostEvents: [ghost, 'f/b', { id: 'f/c', start: 'nope', end: ghost.end }, { ...ghost }],
      }).ghostEvents,
    ).toEqual([ghost]);
    expect(normalizeSettings({}).ghostEvents).toEqual([]);
  });
});

describe('calendar icons', () => {
  it('keeps one emoji (including joined/modified ones) and drops invalid values', () => {
    expect(normalizeIcon(' 🎓 ')).toBe('🎓');
    expect(normalizeIcon('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(normalizeIcon('🏋️‍♀️')).toBe('🏋️‍♀️');
    expect(normalizeIcon('📚📅')).toBe('📚');
    expect(normalizeIcon('')).toBe('');
    expect(normalizeIcon(42)).toBe('');
  });

  it('is read from saved settings', () => {
    const s = normalizeSettings({ calendars: { abc: { color: '#ff0000', icon: '💼' } } });
    expect(s.calendars.abc?.icon).toBe('💼');
  });
});

describe('Nerd Font (Material Design) icons', () => {
  it('keeps a single nf-md icon character', () => {
    const calendarIcon = String.fromCodePoint(0xf00ed); // nf-md-calendar
    expect(normalizeIcon(calendarIcon)).toBe(calendarIcon);
    expect(normalizeIcon(` ${calendarIcon}${String.fromCodePoint(0xf00d6)}`)).toBe(calendarIcon);
  });
});

describe('calendar text color', () => {
  it('keeps a valid chosen color, and is automatic otherwise', () => {
    const s = normalizeSettings({
      calendars: { a: { color: '#ef4444', textColor: '#fde68a' }, b: { textColor: 'yellow' } },
    });
    expect(s.calendars.a?.textColor).toBe('#fde68a');
    expect(s.calendars.b?.textColor).toBe('');
  });

  it('uses the chosen color, or the most readable one when automatic', () => {
    expect(effectiveTextColor({ color: '#ef4444', textColor: '#fde68a' })).toBe('#fde68a');
    expect(effectiveTextColor({ color: '#ef4444', textColor: '' })).toBe('#ffffff');
    expect(effectiveTextColor({ color: '#fde047', textColor: '' })).toBe('#111827');
  });
});
