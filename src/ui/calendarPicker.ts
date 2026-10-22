import type { CalendarOption } from './eventDialog';

export interface CalendarPicker {
  /** The control to insert in the form. */
  readonly element: HTMLElement;
  /** File ID of the selected calendar. */
  readonly value: string;
  setDisabled(disabled: boolean): void;
  isOpen(): boolean;
  close(): void;
}

/** The calendar name, with its icon (if any) before it. */
function withIcon(calendar: CalendarOption | undefined): string {
  if (!calendar) return '';
  return calendar.icon ? `${calendar.icon} ${calendar.displayName}` : calendar.displayName;
}

function dot(color: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'calendar-dot';
  span.style.background = color;
  return span;
}

/**
 * Calendar chooser for the event dialog: like a <select>, but each calendar shows its color dot
 * (native options can only hold plain text). Keyboard: Enter/Space/↓ opens, ↑/↓ move, Enter
 * picks, Escape closes.
 */
export function createCalendarPicker(
  calendars: CalendarOption[],
  initial: string,
  labelId: string,
): CalendarPicker {
  let value = calendars.some((c) => c.fileId === initial) ? initial : (calendars[0]?.fileId ?? '');
  let menu: HTMLElement | null = null;

  const root = document.createElement('div');
  root.className = 'calendar-picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'calendar-picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-labelledby', `${labelId} ${labelId}-value`);
  root.appendChild(button);

  const renderButton = () => {
    const calendar = calendars.find((c) => c.fileId === value);
    const name = document.createElement('span');
    name.className = 'calendar-picker-name';
    name.id = `${labelId}-value`;
    name.textContent = withIcon(calendar);
    const chevron = document.createElement('span');
    chevron.className = 'calendar-picker-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▾';
    button.replaceChildren(dot(calendar?.color ?? 'transparent'), name, chevron);
  };

  const close = (refocus = false) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) button.focus();
  };

  const onOutside = (e: PointerEvent) => {
    if (menu && !root.contains(e.target as Node)) close();
  };

  const open = () => {
    menu = document.createElement('div');
    menu.className = 'time-menu calendar-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', labelId);
    let selected: HTMLButtonElement | null = null;
    for (const calendar of calendars) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'time-option calendar-option';
      option.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.textContent = withIcon(calendar);
      option.append(dot(calendar.color), name);
      if (calendar.fileId === value) {
        option.classList.add('is-selected');
        option.setAttribute('aria-selected', 'true');
        selected = option;
      }
      option.addEventListener('click', () => {
        value = calendar.fileId;
        renderButton();
        close(true);
      });
      menu.appendChild(option);
    }
    menu.addEventListener('keydown', (e) => {
      const options = [...menu!.querySelectorAll<HTMLButtonElement>('.calendar-option')];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        options[Math.min(Math.max(index + step, 0), options.length - 1)]?.focus();
      } else if (e.key === 'Escape') {
        // Close the list only, not the whole dialog.
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') {
        close();
      }
    });
    root.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    (selected ?? menu.querySelector<HTMLButtonElement>('.calendar-option'))?.focus();
    document.addEventListener('pointerdown', onOutside, true);
  };

  button.addEventListener('click', () => (menu ? close(true) : open()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !menu) {
      e.preventDefault();
      open();
    }
  });
  renderButton();

  return {
    element: root,
    get value() {
      return value;
    },
    setDisabled: (disabled) => {
      button.disabled = disabled;
      if (disabled) close();
    },
    isOpen: () => menu !== null,
    close: () => close(true),
  };
}
