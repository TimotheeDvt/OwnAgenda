import type { Theme } from '../store/settingsStore';

const THEME_STORAGE_KEY = 'ics-agenda.theme';

const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';

/** Applies the theme to <html>. "system" removes the override and follows the OS setting. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the theme still applies for this page load.
  }
}

/**
 * The last theme used in this browser. Settings only load after sign-in, so this keeps the page
 * from flashing the wrong theme on startup or while signed out.
 */
export function cachedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}
