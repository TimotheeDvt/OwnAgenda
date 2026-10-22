import type { Theme } from '../store/settingsStore';
import { ICONS } from './icons';

const THEME_STORAGE_KEY = 'ics-agenda.theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let currentTheme: Theme = 'system';
let switchButton: HTMLButtonElement | null = null;

const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';

/** The theme actually on screen ("system" resolved with the OS setting). */
function effectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return darkQuery.matches ? 'dark' : 'light';
  return theme;
}

function syncSwitch(): void {
  if (!switchButton) return;
  const dark = effectiveTheme(currentTheme) === 'dark';
  switchButton.dataset.mode = dark ? 'dark' : 'light';
  switchButton.setAttribute('aria-checked', String(dark));
  switchButton.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

/** Applies the theme to <html>. "system" removes the override and follows the OS setting. */
export function applyTheme(theme: Theme): void {
  currentTheme = theme;
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the theme still applies for this page load.
  }
  syncSwitch();
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

/**
 * Turns the button into a light/dark switch (sun/moon icons, no text). It shows the theme on
 * screen; until it is first used, the theme follows the system. `onToggle` gets the new theme.
 */
export function mountThemeSwitch(button: HTMLButtonElement, onToggle: (theme: Theme) => void) {
  switchButton = button;
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', 'Dark mode');
  button.innerHTML =
    `<span class="theme-switch-knob"></span>` +
    `<span class="theme-switch-icon theme-switch-sun">${ICONS.sun}</span>` +
    `<span class="theme-switch-icon theme-switch-moon">${ICONS.moon}</span>`;
  button.addEventListener('click', () =>
    onToggle(effectiveTheme(currentTheme) === 'dark' ? 'light' : 'dark'),
  );
  // Following the system: keep the switch in step when the OS theme changes.
  darkQuery.addEventListener('change', syncSwitch);
  syncSwitch();
}
