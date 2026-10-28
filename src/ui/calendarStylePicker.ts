import { DEFAULT_CALENDAR_COLORS } from '../config';
import { effectiveTextColor, normalizeIcon } from '../store/settingsStore';
import { DEFAULT_CALENDAR_ICONS } from './iconFont';

/** Preset colors: the default palette plus a few more. */
const PRESET_COLORS = [...DEFAULT_CALENDAR_COLORS, '#0ea5e9', '#84cc16', '#64748b', '#78350f'];

/** Text/icon colors offered: "" = automatic (dark or white, whichever reads best). */
const TEXT_COLORS: [color: string, name: string][] = [
  ['', 'Automatic (best contrast)'],
  ['#ffffff', 'White'],
  ['#111827', 'Black'],
  ['#fde68a', 'Light yellow'],
  ['#1e3a8a', 'Navy'],
];

export interface CalendarStyle {
  color: string;
  icon: string;
  /** "" = automatic. */
  textColor: string;
}

export interface StylePickerOptions extends CalendarStyle {
  /** The element the picker opens next to (the color square). */
  anchor: HTMLElement;
  calendarName: string;
  onChange(patch: Partial<CalendarStyle>): void;
  /** Renames the calendar; without it (read-only) the name can't be edited here. */
  onRename?(name: string): void;
}

let openPicker: { close(): void } | null = null;

/**
 * Small popover to rename a calendar and choose its color (presets or any color), the color of its text and
 * icon (automatic or a few presets), and its icon: one of the
 * Material Design (Nerd Font nf-md) icons, any pasted emoji or nf-md icon, or none.
 * Style changes apply immediately; the name when Enter is pressed, the field is left or the
 * popover closes. It closes on Escape or a click outside.
 */
export function openCalendarStylePicker(options: StylePickerOptions): void {
  openPicker?.close();
  let { color, icon, textColor } = options;

  const panel = document.createElement('div');
  panel.className = 'style-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Name, color and icon of ${options.calendarName}`);

  const heading = (text: string) => {
    const h = document.createElement('div');
    h.className = 'style-picker-heading';
    h.textContent = text;
    return h;
  };

  // Name
  let calendarName = options.calendarName;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'style-name-input';
  nameInput.value = calendarName;
  nameInput.setAttribute('aria-label', 'Calendar name');
  nameInput.title =
    'Stored in the calendar file (X-WR-CALNAME); the file name in your storage stays the same.';
  const commitName = () => {
    const next = nameInput.value.trim();
    if (!next) nameInput.value = calendarName;
    else if (next !== calendarName) {
      calendarName = next;
      options.onRename?.(next);
    }
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitName();
    }
  });

  // Colors
  const swatches = document.createElement('div');
  swatches.className = 'style-swatches';
  const colorButtons = PRESET_COLORS.map((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-swatch';
    btn.style.background = preset;
    btn.setAttribute('aria-label', preset);
    btn.addEventListener('click', () => setColor(preset));
    swatches.appendChild(btn);
    return { btn, preset };
  });
  // Custom color: the browser's own color picker (as the square in the side panel used to be).
  const custom = document.createElement('label');
  custom.className = 'style-custom-color';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.className = 'calendar-color-input';
  customInput.addEventListener('change', () => setColor(customInput.value));
  custom.append(customInput, document.createTextNode('Custom color'));

  // Text & icon color: each tile previews "Aa" on the calendar's color.
  const textRow = document.createElement('div');
  textRow.className = 'style-text-colors';
  const textButtons = TEXT_COLORS.map(([value, name]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-text-color';
    btn.textContent = value ? 'Aa' : 'Auto';
    btn.title = name;
    btn.setAttribute('aria-label', `Text and icon color: ${name}`);
    btn.addEventListener('click', () => setTextColor(value));
    textRow.appendChild(btn);
    return { btn, value };
  });

  // Icons
  const grid = document.createElement('div');
  grid.className = 'style-icons';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'style-icon style-icon-none';
  none.textContent = '∅';
  none.title = 'No icon';
  none.setAttribute('aria-label', 'No icon');
  none.addEventListener('click', () => setIcon(''));
  grid.appendChild(none);
  const iconButtons = DEFAULT_CALENDAR_ICONS.map(([emoji, name]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-icon';
    btn.textContent = emoji;
    btn.title = name;
    btn.setAttribute('aria-label', name);
    btn.addEventListener('click', () => setIcon(emoji));
    grid.appendChild(btn);
    return { btn, emoji };
  });
  const iconInput = document.createElement('input');
  iconInput.type = 'text';
  iconInput.className = 'style-icon-input';
  iconInput.placeholder = 'Or paste an emoji / nf-md icon';
  iconInput.maxLength = 16;
  iconInput.setAttribute('aria-label', 'Custom icon (emoji or Nerd Font nf-md icon)');
  iconInput.addEventListener('input', () => {
    const value = normalizeIcon(iconInput.value);
    if (value) setIcon(value, false);
  });

  if (options.onRename) panel.append(heading('Name'), nameInput);
  panel.append(
    heading('Color'),
    swatches,
    custom,
    heading('Text & icon'),
    textRow,
    heading('Icon'),
    grid,
    iconInput,
  );

  function sync() {
    for (const { btn, preset } of colorButtons) {
      const selected = preset.toLowerCase() === color.toLowerCase();
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-pressed', String(selected));
    }
    const isCustom = !PRESET_COLORS.some((p) => p.toLowerCase() === color.toLowerCase());
    custom.classList.toggle('is-selected', isCustom);
    customInput.value = color;
    for (const { btn, value } of textButtons) {
      btn.style.background = color;
      btn.style.color = effectiveTextColor({ color, textColor: value });
      const selected = value === textColor;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-pressed', String(selected));
    }
    none.classList.toggle('is-selected', icon === '');
    for (const { btn, emoji } of iconButtons) btn.classList.toggle('is-selected', emoji === icon);
  }

  function setColor(next: string) {
    color = next;
    sync();
    options.onChange({ color });
  }

  function setTextColor(next: string) {
    textColor = next;
    sync();
    options.onChange({ textColor });
  }

  function setIcon(next: string, clearInput = true) {
    icon = next;
    if (clearInput) iconInput.value = '';
    sync();
    options.onChange({ icon });
  }

  const close = () => {
    // Closing doesn't blur the field first: keep a name typed but not confirmed yet.
    if (options.onRename) commitName();
    panel.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (openPicker === handle) openPicker = null;
  };
  const onOutside = (e: PointerEvent) => {
    if (!panel.contains(e.target as Node) && !options.anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const handle = { close };
  openPicker = handle;

  sync();
  document.body.appendChild(panel);

  /**
   * Places it under the square (or above, if there's no room), within the window. Runs again on
   * resize instead of closing: on phones the on-screen keyboard (for the emoji field) resizes it.
   */
  function place() {
    const margin = 8;
    const { width, height } = panel.getBoundingClientRect();
    // The side panel re-renders after a change, which may replace the square: keep the position.
    const rect = options.anchor.isConnected ? options.anchor.getBoundingClientRect() : null;
    const left = rect ? rect.left : panel.offsetLeft;
    const below = rect ? rect.bottom + 6 : panel.offsetTop;
    const above = rect ? rect.top - height - 6 : panel.offsetTop;
    const top = below + height + margin > window.innerHeight ? above : below;
    panel.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - width - margin)}px`;
    panel.style.top = `${Math.min(Math.max(top, margin), window.innerHeight - height - margin)}px`;
  }
  place();

  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  (panel.querySelector<HTMLElement>('.is-selected') ?? colorButtons[0]?.btn)?.focus();
}
