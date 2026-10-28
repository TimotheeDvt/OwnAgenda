/** OAuth client ID (public). Set VITE_GOOGLE_CLIENT_ID in .env.local or as a CI variable. */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

/**
 * OAuth scopes requested at sign-in. Kept in one place so they are easy to change later
 * (e.g. switching to drive.file + Google Picker).
 * - drive: resolve a folder path and read/write .ics files the app did not create (restricted).
 * - drive.appdata: hidden settings.json in the appDataFolder.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.appdata',
] as const;

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** Solid provider suggested at sign-in (the free community server run by the Solid Project). */
export const SOLID_DEFAULT_ISSUER = 'https://solidcommunity.net';
/** Name shown on the Solid provider's consent screen. */
export const SOLID_CLIENT_NAME = 'OwnAgenda';
/**
 * Settings file in a Solid pod, relative to the pod root. /settings/ is the usual private
 * folder for app preferences (only the owner can read it).
 */
export const SOLID_SETTINGS_PATH = 'settings/ownagenda.json';

export const SETTINGS_FILE_NAME = 'settings.json';
export const SETTINGS_VERSION = 1;
export const SETTINGS_SAVE_DEBOUNCE_MS = 1000;

/** Refresh the access token this long before Google says it expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Safety cap on occurrences iterated per recurring event (guards against runaway RRULEs). */
export const MAX_RECURRENCE_ITERATIONS = 100_000;

/** Colors assigned to calendars that have no saved color yet. */
export const DEFAULT_CALENDAR_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
] as const;
