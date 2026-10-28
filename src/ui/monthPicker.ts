export interface MonthPickerOptions {
  /** The month shown in the calendar, "YYYY-MM". */
  current: string;
  /** Today's month, "YYYY-MM" (marked in the grid). */
  today: string;
  /** Goes to a month ("YYYY-MM"). */
  onPick(month: string): void;
  /** Goes to today. */
  onToday(): void;
}

const MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
  new Date(Date.UTC(2000, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
);

/** Years shown at once in the year grid: the current one in a block of 12. */
const YEARS_PER_PAGE = 12;

let openPicker: { close(): void } | null = null;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Small calendar under the toolbar title to jump to a month: "‹ 2026 ›" changes the year, the
 * year itself opens a grid of years, a month goes there. Closes on a pick, Escape, a click
 * outside or a second click on the title.
 */
export function openMonthPicker(anchor: HTMLElement, options: MonthPickerOptions): void {
  const wasOpen = openPicker !== null;
  openPicker?.close();
  // A second click on the title closes the picker.
  if (wasOpen) return;

  const [currentYear, currentMonth] = options.current.split('-').map(Number) as [number, number];
  const [todayYear, todayMonth] = options.today.split('-').map(Number) as [number, number];
  let year = currentYear;
  let mode: 'months' | 'years' = 'months';

  const picker = document.createElement('div');
  picker.className = 'month-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Go to a month');

  const header = document.createElement('div');
  header.className = 'month-picker-header';
  const navButton = (label: string, text: string, step: number) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'month-picker-nav';
    btn.textContent = text;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => {
      year += mode === 'months' ? step : step * YEARS_PER_PAGE;
      render();
    });
    return btn;
  };
  const prev = navButton('Previous', '‹', -1);
  const next = navButton('Next', '›', 1);
  const heading = document.createElement('button');
  heading.type = 'button';
  heading.className = 'month-picker-heading';
  heading.addEventListener('click', () => {
    mode = mode === 'months' ? 'years' : 'months';
    render();
  });
  header.append(prev, heading, next);

  const grid = document.createElement('div');
  grid.className = 'month-picker-grid';

  const footer = document.createElement('div');
  footer.className = 'month-picker-footer';
  const today = document.createElement('button');
  today.type = 'button';
  today.className = 'btn';
  today.textContent = 'Today';
  today.addEventListener('click', () => {
    close();
    options.onToday();
  });
  footer.append(today);
  picker.append(header, grid, footer);

  const cell = (text: string, selected: boolean, isToday: boolean, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'month-picker-cell';
    btn.textContent = text;
    btn.classList.toggle('is-selected', selected);
    btn.classList.toggle('is-today', isToday);
    if (selected) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', onClick);
    return btn;
  };

  function render(): void {
    if (mode === 'months') {
      heading.textContent = String(year);
      heading.title = 'Choose a year';
      grid.replaceChildren(
        ...MONTH_NAMES.map((name, i) =>
          cell(
            name,
            year === currentYear && i + 1 === currentMonth,
            year === todayYear && i + 1 === todayMonth,
            () => {
              close();
              options.onPick(`${year}-${pad(i + 1)}`);
            },
          ),
        ),
      );
    } else {
      // The block of 12 years holding `year`, e.g. 2016–2027.
      const first = year - (((year % YEARS_PER_PAGE) + YEARS_PER_PAGE) % YEARS_PER_PAGE);
      heading.textContent = `${first} – ${first + YEARS_PER_PAGE - 1}`;
      heading.title = 'Back to the months';
      grid.replaceChildren(
        ...Array.from({ length: YEARS_PER_PAGE }, (_, i) => first + i).map((y) =>
          cell(String(y), y === currentYear, y === todayYear, () => {
            year = y;
            mode = 'months';
            render();
            grid.querySelector<HTMLElement>('.month-picker-cell')?.focus();
          }),
        ),
      );
    }
  }
  render();

  const close = (refocus = false) => {
    picker.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (openPicker === handle) openPicker = null;
    if (refocus) anchor.focus();
  };
  const handle = { close: () => close() };
  const onOutside = (e: PointerEvent) => {
    const target = e.target as Node;
    // The title's own click toggles the picker: let it through, closing happens there.
    if (picker.contains(target) || anchor.contains(target)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
      return;
    }
    // The app's shortcuts (arrows change the period, letters the view) don't run behind it.
    if (picker.contains(document.activeElement)) e.stopPropagation();
  };

  document.body.append(picker);
  // Under the title, centered on it, within the window.
  const place = () => {
    // The toolbar was rebuilt (e.g. the window got narrow).
    if (!anchor.isConnected) return close();
    const margin = 8;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = picker.getBoundingClientRect();
    const left = rect.left + rect.width / 2 - width / 2;
    const below = rect.bottom + 6;
    const top = below + height + margin > window.innerHeight ? rect.top - height - 6 : below;
    picker.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - width - margin)}px`;
    picker.style.top = `${Math.max(top, margin)}px`;
  };
  place();

  anchor.setAttribute('aria-expanded', 'true');
  openPicker = handle;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  (grid.querySelector<HTMLElement>('.is-selected') ?? heading).focus();
}
