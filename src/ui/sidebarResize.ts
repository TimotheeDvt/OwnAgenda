// Resizable sidebar: drag the handle on its right edge (or use ←/→ when it is focused,
// double-click to reset). The width is remembered per device, since it depends on the screen.

const STORAGE_KEY = 'ics-agenda.sidebarWidth';
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const KEYBOARD_STEP = 16;

function clampWidth(width: number): number {
  // Never let the sidebar take more than 60% of the window.
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.6));
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(max, MIN_WIDTH)));
}

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return value > 0 ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Storage unavailable: the width just isn't remembered.
  }
}

/**
 * Makes `handle` resize the sidebar through the --sidebar-width CSS variable. `onResize` runs
 * after each change (the calendar needs to re-measure itself).
 */
export function setupSidebarResize(handle: HTMLElement, onResize: () => void): void {
  let width = clampWidth(readWidth());
  let frame = 0;

  const apply = (next: number, save: boolean) => {
    width = clampWidth(next);
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    if (save) saveWidth(width);
    // At most one calendar re-layout per frame while dragging.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onResize);
  };

  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the side panel');
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH));
  handle.title = 'Drag to resize · double-click to reset';
  handle.tabIndex = 0;
  apply(width, false);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const pointerId = e.pointerId;
    document.body.classList.add('is-resizing-sidebar');

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) apply(startWidth + (ev.clientX - startX), false);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove('is-resizing-sidebar');
      apply(width, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  });

  handle.addEventListener('dblclick', () => apply(DEFAULT_WIDTH, true));

  handle.addEventListener('keydown', (e) => {
    const step =
      e.key === 'ArrowLeft' ? -KEYBOARD_STEP : e.key === 'ArrowRight' ? KEYBOARD_STEP : 0;
    if (!step) return;
    e.preventDefault();
    apply(width + step, true);
  });

  // Keep within limits when the window gets smaller.
  window.addEventListener('resize', () => {
    if (clampWidth(width) !== width) apply(width, false);
  });
}
