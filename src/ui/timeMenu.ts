import { normalizeTime } from '../util/dates';

const STEP_MINUTES = 30;

/** "00:00", "00:30", ... "23:30". */
export const HALF_HOURS: string[] = Array.from({ length: (24 * 60) / STEP_MINUTES }, (_, i) => {
  const minutes = i * STEP_MINUTES;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

export interface TimeMenu {
  isOpen(): boolean;
  close(): void;
}

/**
 * A clock button next to a time field that opens a list of half-hour times. Picking one fills
 * the field and fires its "change" event (so the dialog reacts as if it was typed). The field
 * stays editable for any other time.
 *
 * `hint` can add a note to each time (e.g. the duration for the end time).
 */
export function attachTimeMenu(
  input: HTMLInputElement,
  button: HTMLButtonElement,
  hint?: (time: string) => string,
): TimeMenu {
  const field = button.parentElement!;
  let menu: HTMLElement | null = null;

  const close = (refocus = false) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) button.focus();
  };

  const onOutside = (e: PointerEvent) => {
    if (menu && !field.contains(e.target as Node)) close();
  };

  const pick = (time: string) => {
    input.value = time;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.focus();
  };

  const open = () => {
    menu = document.createElement('div');
    menu.className = 'time-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', input.getAttribute('aria-label') ?? 'Time');

    const current = normalizeTime(input.value);
    let selected: HTMLButtonElement | null = null;
    for (const time of HALF_HOURS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'time-option';
      option.setAttribute('role', 'option');
      option.textContent = time;
      const note = hint?.(time);
      if (note) {
        const span = document.createElement('span');
        span.className = 'time-hint';
        span.textContent = note;
        option.appendChild(span);
      }
      // The current time, or the slot just before it (e.g. 10:15 → 10:00).
      if (current && time <= current) selected = option;
      option.addEventListener('click', () => pick(time));
      menu.appendChild(option);
    }
    selected ??= menu.querySelector<HTMLButtonElement>('.time-option:nth-child(19)'); // 09:00
    if (selected && current) {
      selected.classList.add('is-selected');
      selected.setAttribute('aria-selected', 'true');
    }

    menu.addEventListener('keydown', (e) => {
      const options = [...menu!.querySelectorAll<HTMLButtonElement>('.time-option')];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next =
          options[
            Math.min(Math.max(index + (e.key === 'ArrowDown' ? 1 : -1), 0), options.length - 1)
          ];
        next?.focus();
      } else if (e.key === 'Escape') {
        // Close the menu only, not the whole dialog.
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') {
        close();
      }
    });

    field.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    // Scroll the list (not the dialog) so the selected time is in the middle.
    if (selected) {
      menu.scrollTop = selected.offsetTop - menu.clientHeight / 2 + selected.offsetHeight / 2;
      selected.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', onOutside, true);
  };

  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu ? close(true) : open()));

  return { isOpen: () => menu !== null, close: () => close(true) };
}
