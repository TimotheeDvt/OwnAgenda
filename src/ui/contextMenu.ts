import { ICONS, type IconName } from './icons';

export interface ContextMenuItem {
  label: string;
  icon: IconName;
  onSelect(): void;
  /** Red, for destructive actions (Delete). */
  danger?: boolean;
  /** Greyed out; `title` says why. */
  disabled?: boolean;
  title?: string;
  /** Key that picks the item while the menu is open (not shown), e.g. "E", "Delete". */
  key?: string;
}

/** `null` draws a separator line between groups of items. */
export type ContextMenuEntry = ContextMenuItem | null;

let openMenu: { close(): void } | null = null;

/**
 * Right-click menu at a point of the window (kept inside it). Closes on a pick, Escape, a click
 * outside, scrolling or resizing. Arrow keys, Home/End move between the items; an item's `key`
 * picks it. Other keys are swallowed, so the app's shortcuts don't run behind the menu.
 */
export function openContextMenu(
  x: number,
  y: number,
  entries: ContextMenuEntry[],
  label: string,
): void {
  openMenu?.close();

  const returnFocus = document.activeElement as HTMLElement | null;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);

  const close = (refocus = false) => {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
    if (openMenu === handle) openMenu = null;
    if (refocus) returnFocus?.focus();
  };
  const handle = { close: () => close() };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onScroll = () => close();
  const onResize = () => close();

  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if (!entry) {
      const separator = document.createElement('div');
      separator.className = 'context-menu-separator';
      separator.setAttribute('role', 'separator');
      menu.append(separator);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `context-menu-item${entry.danger ? ' is-danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.disabled = entry.disabled ?? false;
    if (entry.title) item.title = entry.title;
    const glyph = document.createElement('span');
    glyph.className = 'context-menu-icon';
    glyph.innerHTML = ICONS[entry.icon];
    const text = document.createElement('span');
    text.textContent = entry.label;
    item.append(glyph, text);
    if (entry.key) item.setAttribute('aria-keyshortcuts', entry.key);
    item.addEventListener('click', () => {
      close();
      entry.onSelect();
    });
    menu.append(item);
    items.push(item);
  }

  const onKey = (e: KeyboardEvent) => {
    const enabled = items.filter((i) => !i.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const picked = entries.find(
      (entry) => entry?.key && !entry.disabled && entry.key.toLowerCase() === e.key.toLowerCase(),
    );
    if (picked && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      close();
      picked.onSelect();
      return;
    }
    if (e.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    // Enter and Space click the focused item.
    else if (e.key === 'Enter' || e.key === ' ') return;
    // Keeps the app's own shortcuts (arrows change the period, letters the view) from running.
    e.stopPropagation();
    if (!e.ctrlKey && !e.metaKey) e.preventDefault();
    next?.focus();
  };

  document.body.append(menu);
  // At the pointer, flipped left/up when it would overflow the window.
  const margin = 8;
  const { width, height } = menu.getBoundingClientRect();
  const left = x + width + margin > window.innerWidth ? x - width : x;
  const top = y + height + margin > window.innerHeight ? y - height : y;
  menu.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - width - margin)}px`;
  menu.style.top = `${Math.min(Math.max(top, margin), window.innerHeight - height - margin)}px`;

  openMenu = handle;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onResize);
  items.find((i) => !i.disabled)?.focus({ preventScroll: true });
}
