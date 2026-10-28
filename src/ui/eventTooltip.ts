export interface EventTooltipContent {
  title: string;
  when: string;
  calendar?: { name: string; color: string };
  /** Further lines (repeat, location, notes), empty ones left out. */
  lines: (string | undefined)[];
}

/** Shows quicker than the browser's title tooltip (about a second). */
const SHOW_DELAY_MS = 250;
const OFFSET_PX = 14;

let card: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let owner: HTMLElement | null = null;

function hide(): void {
  clearTimeout(timer);
  card?.remove();
  card = null;
  owner = null;
}

function build(content: EventTooltipContent): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'event-tooltip';
  el.setAttribute('role', 'tooltip');
  const title = document.createElement('div');
  title.className = 'event-tooltip-title';
  title.textContent = content.title;
  const when = document.createElement('div');
  when.className = 'event-tooltip-when';
  when.textContent = content.when;
  el.append(title, when);
  if (content.calendar) {
    const calendar = document.createElement('div');
    calendar.className = 'event-tooltip-calendar';
    const dot = document.createElement('span');
    dot.className = 'event-tooltip-dot';
    dot.style.background = content.calendar.color;
    calendar.append(dot, content.calendar.name);
    el.append(calendar);
  }
  for (const line of content.lines) {
    if (!line) continue;
    const row = document.createElement('div');
    row.className = 'event-tooltip-line';
    row.textContent = line;
    el.append(row);
  }
  return el;
}

/** Next to the pointer, flipped left/up when it would overflow the window. */
function place(el: HTMLElement, x: number, y: number): void {
  const margin = 8;
  const { width, height } = el.getBoundingClientRect();
  let left = x + OFFSET_PX;
  let top = y + OFFSET_PX;
  if (left + width + margin > window.innerWidth) left = x - OFFSET_PX - width;
  if (top + height + margin > window.innerHeight) top = y - OFFSET_PX - height;
  el.style.left = `${Math.max(left, margin)}px`;
  el.style.top = `${Math.max(top, margin)}px`;
}

/**
 * Hover card of an event (mouse only: on touch screens a tap opens the event). Hidden when the
 * pointer leaves, on a click or drag start, and on scroll. `content` is read when it shows; null
 * shows nothing (e.g. while dragging another event).
 */
export function attachEventTooltip(
  el: HTMLElement,
  content: () => EventTooltipContent | null,
): void {
  let x = 0;
  let y = 0;
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    hide();
    owner = el;
    x = e.clientX;
    y = e.clientY;
    timer = setTimeout(() => {
      // The event was re-rendered (e.g. refetched) while waiting.
      if (!el.isConnected || owner !== el) return;
      const shown = content();
      if (!shown) return;
      card = build(shown);
      document.body.append(card);
      place(card, x, y);
    }, SHOW_DELAY_MS);
  });
  el.addEventListener('pointermove', (e) => {
    x = e.clientX;
    y = e.clientY;
    if (card && owner === el) place(card, x, y);
  });
  el.addEventListener('pointerleave', () => {
    if (owner === el) hide();
  });
  el.addEventListener('pointerdown', hide);
  el.addEventListener('contextmenu', hide);
}

/** Hides the card if it belongs to `el` (the event is being removed). */
export function detachEventTooltip(el: HTMLElement): void {
  if (owner === el) hide();
}

document.addEventListener('scroll', hide, true);
