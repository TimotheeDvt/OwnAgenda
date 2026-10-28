import {
  normalizeSettings,
  type CalendarSettings,
  type GhostEvent,
  type Settings,
} from './settingsStore';

// Moves settings between storages (e.g. Google Drive to a Solid pod). Settings refer to calendars
// by file ID, which differs in every storage, so the exported file uses file names instead and
// the import matches them to the files of the current folder. The folder path is never exported:
// each storage keeps its own.

export const SETTINGS_EXPORT_FORMAT = 'ownagenda-settings';

export interface SettingsFile {
  id: string;
  /** File name, e.g. "work.ics". */
  name: string;
}

export interface ImportResult {
  settings: Settings;
  /** File names of the export found in the current folder. */
  matched: string[];
  /** File names of the export with no file of that name here (their settings are dropped). */
  missing: string[];
}

/** Rewrites every calendar reference with `map`; references it returns null for are dropped. */
function remap(settings: Settings, map: (id: string) => string | null): Settings {
  const ids = (list: string[]) => list.map(map).filter((id): id is string => id !== null);
  const calendars: Record<string, CalendarSettings> = {};
  for (const [id, value] of Object.entries(settings.calendars)) {
    const mapped = map(id);
    if (mapped !== null) calendars[mapped] = value;
  }
  return {
    ...settings,
    calendarOrder: ids(settings.calendarOrder),
    calendars,
    ghostEvents: remapGhosts(settings.ghostEvents, map),
    shownBeforeHideAll: settings.shownBeforeHideAll && ids(settings.shownBeforeHideAll),
  };
}

/** Ghost ids are "<file id>/<event id>": the file part is remapped. */
function remapGhosts(ghosts: GhostEvent[], map: (id: string) => string | null): GhostEvent[] {
  return ghosts.flatMap((ghost) => {
    // File IDs may contain "/" themselves (Solid URLs): try the longest known prefix first.
    for (let end = ghost.id.lastIndexOf('/'); end > 0; end = ghost.id.lastIndexOf('/', end - 1)) {
      const mapped = map(ghost.id.slice(0, end));
      if (mapped !== null) return [{ ...ghost, id: `${mapped}${ghost.id.slice(end)}` }];
    }
    return [];
  });
}

/** The settings as an export: calendars by file name, without the folder path. */
export function exportSettings(settings: Settings, files: SettingsFile[]): unknown {
  const nameById = new Map(files.map((f) => [f.id, f.name]));
  const portable: Partial<Settings> = remap(settings, (id) => nameById.get(id) ?? null);
  delete portable.folderPath;
  return {
    format: SETTINGS_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    settings: portable,
  };
}

/**
 * Applies an export over `current`: calendars are matched by file name to `files` (the current
 * folder). The current folder path is kept; settings of calendars not in the export are kept.
 */
export function importSettings(
  current: Settings,
  data: unknown,
  files: SettingsFile[],
): ImportResult {
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  if (raw?.format !== SETTINGS_EXPORT_FORMAT || typeof raw.settings !== 'object') {
    throw new Error('This file is not an OwnAgenda settings export.');
  }
  const imported = normalizeSettings({ ...(raw.settings as object), folderPath: '' });
  const idByName = new Map(files.map((f) => [f.name, f.id]));

  const names = new Set([
    ...Object.keys(imported.calendars),
    ...imported.calendarOrder,
    ...(imported.shownBeforeHideAll ?? []),
  ]);
  const matched = [...names].filter((n) => idByName.has(n)).sort();
  const missing = [...names].filter((n) => !idByName.has(n)).sort();

  const mapped = remap(imported, (name) => idByName.get(name) ?? null);
  const ghostIds = new Set(mapped.ghostEvents.map((g) => g.id));
  return {
    settings: {
      ...mapped,
      folderPath: current.folderPath,
      calendars: { ...current.calendars, ...mapped.calendars },
      calendarOrder: [
        ...mapped.calendarOrder,
        ...current.calendarOrder.filter((id) => !mapped.calendarOrder.includes(id)),
      ],
      ghostEvents: [
        ...mapped.ghostEvents,
        ...current.ghostEvents.filter((g) => !ghostIds.has(g.id)),
      ],
    },
    matched,
    missing,
  };
}
