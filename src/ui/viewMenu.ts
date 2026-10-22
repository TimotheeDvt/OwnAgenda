import type { ViewName } from '../store/settingsStore';

export interface ViewMenuOptions {
  current: string;
  views: { view: ViewName; label: string }[];
  onPick(view: ViewName): void;
}

let openMenu: { close(): void } | null = null;

/**
 * Phone view switcher: a small menu above the toolbar button (the toolbar is at the bottom of
 * the screen). Closes on a pick, Escape, a second tap on the button or a tap outside.
 */
export function openViewMenu(anchor: HTMLElement, options: ViewMenuOptions): void {
  const wasOpen = openMenu !== null;
  openMenu?.close();
  // A second tap on the button closes the menu.
  if (wasOpen) return;

  const menu = document.createElement('div');
  menu.className = 'view-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Views');

  const close = (refocus = false) => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (openMenu === handle) openMenu = null;
    if (refocus) anchor.focus();
  };
  const handle = { close: () => close() };
  const onOutside = (e: PointerEvent) => {
    const target = e.target as Node;
    if (menu.contains(target)) return;
    // The button's own click toggles the menu: let it through, closing happens there.
    if (anchor.contains(target)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    }
  };

  let selected: HTMLButtonElement | null = null;
  for (const { view, label } of options.views) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'view-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(view === options.current));
    item.textContent = label;
    if (view === options.current) {
      item.classList.add('is-selected');
      selected = item;
    }
    item.addEventListener('click', () => {
      close();
      if (view !== options.current) options.onPick(view);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  // Above the button, centered on it, within the window. Runs again on resize (phone browsers
  // resize the page when their address bar shows or hides).
  const place = () => {
    // The toolbar was rebuilt (e.g. the window got wide enough for the view buttons).
    if (!anchor.isConnected) return close();
    const margin = 8;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const left = rect.left + rect.width / 2 - width / 2;
    menu.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - width - margin)}px`;
    menu.style.top = `${Math.max(rect.top - height - 6, margin)}px`;
  };
  place();

  anchor.setAttribute('aria-expanded', 'true');
  openMenu = handle;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  selected?.focus();
}
