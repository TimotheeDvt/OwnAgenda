import { DEFAULT_CALENDAR_COLORS, SETTINGS_SAVE_DEBOUNCE_MS, SETTINGS_VERSION } from '../config';
import { storage } from '../storage';
import { browserTimeZone, isValidTimeZone } from '../util/timeZone';

export const VIEW_NAMES = ['dayGridMonth', 'timeGridWeek', 'timeGridDay', 'listWeek'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export type Theme = 'system' | 'light' | 'dark';

export interface CalendarSettings {
  color: string;
  visible: boolean;
}

export interface Settings {
  version: number;
  folderPath: string;
  defaultView: ViewName;
  weekStartsOn: number;
  timeZone: string;
  theme: Theme;
  /** Keep a copy of the calendars in this browser (IndexedDB) for fast startup and offline use. */
  offlineCache: boolean;
  /**
   * CORS proxy for downloading subscribed calendars whose server blocks browser requests.
   * A URL template where {url} is replaced by the encoded calendar link. Empty = direct.
   */
  corsProxy: string;
  /** File IDs in the order chosen in the sidebar; calendars not listed come after, by name. */
  calendarOrder: string[];
  calendars: Record<string, CalendarSettings>;
}

export type SettingsListener = (settings: Settings) => void;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    folderPath: '',
    defaultView: 'timeGridWeek',
    weekStartsOn: 1,
    timeZone: browserTimeZone(),
    theme: 'system',
    offlineCache: true,
    corsProxy: '',
    calendarOrder: [],
    calendars: {},
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Merges a raw settings object over the defaults. Invalid fields fall back to defaults; unknown
 * fields are kept so settings written by a newer version of the app are not lost.
 */
export function normalizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;

  const calendars: Record<string, CalendarSettings> = {};
  if (isRecord(raw.calendars)) {
    for (const [fileId, value] of Object.entries(raw.calendars)) {
      if (!isRecord(value)) continue;
      calendars[fileId] = {
        ...value,
        color: typeof value.color === 'string' && HEX_COLOR.test(value.color) ? value.color : '',
        visible: typeof value.visible === 'boolean' ? value.visible : true,
      };
    }
  }

  return {
    ...raw,
    version: SETTINGS_VERSION,
    folderPath: typeof raw.folderPath === 'string' ? raw.folderPath.trim() : defaults.folderPath,
    defaultView: VIEW_NAMES.includes(raw.defaultView as ViewName)
      ? (raw.defaultView as ViewName)
      : defaults.defaultView,
    weekStartsOn:
      Number.isInteger(raw.weekStartsOn) &&
      (raw.weekStartsOn as number) >= 0 &&
      (raw.weekStartsOn as number) <= 6
        ? (raw.weekStartsOn as number)
        : defaults.weekStartsOn,
    timeZone:
      typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone)
        ? raw.timeZone
        : defaults.timeZone,
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : defaults.theme,
    offlineCache: typeof raw.offlineCache === 'boolean' ? raw.offlineCache : defaults.offlineCache,
    corsProxy: typeof raw.corsProxy === 'string' ? raw.corsProxy.trim() : defaults.corsProxy,
    calendarOrder: Array.isArray(raw.calendarOrder)
      ? [...new Set(raw.calendarOrder.filter((id): id is string => typeof id === 'string'))]
      : defaults.calendarOrder,
    calendars,
  };
}

let settings: Settings = defaultSettings();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let errorHandler: (err: unknown) => void = (err) => console.error(err);
const listeners = new Set<SettingsListener>();

function notify(): void {
  listeners.forEach((l) => l(settings));
}

export function getSettings(): Settings {
  return settings;
}

/** Shows settings from the offline copy until Drive answers (not written back to Drive). */
export function applyCachedSettings(raw: unknown): void {
  settings = normalizeSettings(raw);
  notify();
}

export async function loadSettings(): Promise<Settings> {
  settings = normalizeSettings(await storage().readSettings());
  notify();
  return settings;
}

/** False while offline/read-only: changes apply locally and are written once it's back. */
let persistenceEnabled = true;
let changedWhilePaused = false;

/**
 * Pauses or resumes writing settings to storage. On resume, changes made in the meantime are
 * written. Returns true if there were such changes (so they shouldn't be overwritten by a reload).
 */
export function setSettingsPersistence(enabled: boolean): boolean {
  persistenceEnabled = enabled;
  if (!enabled) return false;
  const hadChanges = changedWhilePaused;
  changedWhilePaused = false;
  if (hadChanges) schedulePersist();
  return hadChanges;
}

function schedulePersist(): void {
  if (!persistenceEnabled) {
    changedWhilePaused = true;
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    storage().writeSettings(settings).catch(errorHandler);
  }, SETTINGS_SAVE_DEBOUNCE_MS);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  notify();
  schedulePersist();
}

/** The saved settings for a calendar, or defaults (color picked by its position in the list). */
/**
 * Sorts calendars by the saved order. Calendars missing from it (new files) keep their relative
 * order after the ordered ones.
 */
export function orderCalendars<T extends { fileId: string }>(
  items: T[],
  order: string[] = settings.calendarOrder,
): T[] {
  const position = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, key: position.get(item.fileId) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

/**
 * Moves the calendar at `from` to `to` within the displayed list and saves the new order.
 * IDs of calendars not currently shown (e.g. a file that failed to load) keep their place at the
 * end, so they come back where they were.
 */
export function moveCalendar(displayedIds: string[], from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= displayedIds.length) return;
  const ids = [...displayedIds];
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.min(to, ids.length), 0, moved!);
  const hidden = settings.calendarOrder.filter((id) => !displayedIds.includes(id));
  updateSettings({ calendarOrder: [...ids, ...hidden] });
}

export function getCalendarSettings(fileId: string, index: number): CalendarSettings {
  const fallbackColor =
    DEFAULT_CALENDAR_COLORS[Math.max(index, 0) % DEFAULT_CALENDAR_COLORS.length] ?? '#3b82f6';
  const saved = settings.calendars[fileId];
  return {
    visible: saved?.visible ?? true,
    color: saved?.color || fallbackColor,
  };
}

export function updateCalendarSettings(
  fileId: string,
  index: number,
  patch: Partial<CalendarSettings>,
): void {
  updateSettings({
    calendars: {
      ...settings.calendars,
      [fileId]: { ...settings.calendars[fileId], ...getCalendarSettings(fileId, index), ...patch },
    },
  });
}

/** Writes any pending change immediately. */
export async function flushSettings(): Promise<void> {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await storage().writeSettings(settings);
}

/** Drops in-memory settings without saving (on sign-out). */
export function resetSettings(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  changedWhilePaused = false;
  settings = defaultSettings();
  notify();
}

export function onSettingsChange(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSettingsSaveError(handler: (err: unknown) => void): void {
  errorHandler = handler;
}
