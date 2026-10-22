import {
  getCalendarState,
  onCalendarsChange,
  subscriptionOf,
  type CalendarState,
} from '../store/calendarStore';
import {
  getCalendarSettings,
  getSettings,
  moveCalendar,
  onSettingsChange,
  orderCalendars,
  updateCalendarSettings,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { ICONS, type IconName } from './icons';
import { mountSearch } from './search';

export interface SidebarActions {
  onChangeFolder(): void;
  onReload(): void;
  onRefreshCalendar(fileId: string): void;
  onRenameCalendar(fileId: string): void;
  onNewCalendar(): void;
  onSubscribe(): void;
  onSetCorsProxy(): void;
  onPickSearchResult(event: AgendaEvent): void;
  onToggleOfflineCache(enabled: boolean): void;
  onShowShortcuts(): void;
}

export interface Sidebar {
  focusSearch(): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', className, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function iconButton(icon: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const btn = button('', 'icon-btn', onClick);
  btn.innerHTML = ICONS[icon];
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
}

function renderFolder(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  const path = getSettings().folderPath;
  const buttons = el('div', 'sidebar-buttons');
  buttons.appendChild(
    iconButton('edit', path ? 'Change folder' : 'Set folder', actions.onChangeFolder),
  );
  if (path) {
    const loading = state.status === 'loading';
    const reload = iconButton(
      'refresh',
      'Reload all calendars of the folder from Google Drive',
      actions.onReload,
    );
    reload.disabled = loading;
    if (loading) reload.classList.add('is-spinning');
    buttons.appendChild(reload);
  }

  const folderIcon = el('span', 'folder-icon');
  folderIcon.innerHTML = ICONS.folder;
  folderIcon.setAttribute('role', 'img');
  folderIcon.setAttribute('aria-label', 'Folder');
  folderIcon.title = 'Google Drive folder';

  const pathLabel = el('span', 'folder-path', path || 'Not set');
  pathLabel.title = path;
  const row = el('div', 'folder-row');
  row.append(folderIcon, pathLabel, buttons);
  return [row];
}

/** After a keyboard move the list re-renders: put focus back on the moved calendar's handle. */
let focusAfterRender: string | null = null;

/**
 * Pointer-based drag (mouse, pen and touch alike): the row follows the pointer by moving in the
 * list as it crosses the middle of its neighbours. The new order is saved on release.
 */
function startDrag(
  e: PointerEvent,
  handle: HTMLElement,
  list: HTMLUListElement,
  orderedIds: string[],
): void {
  if (e.button !== 0) return;
  const item = handle.closest<HTMLLIElement>('li');
  if (!item) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const from = [...list.children].indexOf(item);
  item.classList.add('is-dragging');
  list.classList.add('is-reordering');

  const middle = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const onMove = (ev: PointerEvent) => {
    let prev = item.previousElementSibling;
    while (prev && ev.clientY < middle(prev)) {
      list.insertBefore(item, prev);
      prev = item.previousElementSibling;
    }
    let next = item.nextElementSibling;
    while (next && ev.clientY > middle(next)) {
      list.insertBefore(next, item);
      next = item.nextElementSibling;
    }
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    item.classList.remove('is-dragging');
    list.classList.remove('is-reordering');
    const to = [...list.children].indexOf(item);
    if (to !== from) moveCalendar(orderedIds, from, to);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function renderCalendars(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  const nodes: HTMLElement[] = [el('h2', 'sidebar-title', 'Calendars')];

  if (state.status === 'loading') {
    nodes.push(
      el('p', 'muted', state.calendars.length ? 'Updating from Google Drive…' : 'Loading…'),
    );
  }
  if (state.error) nodes.push(el('p', 'sidebar-error', state.error));

  const list = el('ul', 'calendar-list');
  const ordered = orderCalendars(state.calendars);
  const orderedIds = ordered.map((c) => c.fileId);
  ordered.forEach((calendar, position) => {
    // Default colors follow the stable name order, so reordering doesn't change them.
    const index = state.calendars.indexOf(calendar);
    const settings = getCalendarSettings(calendar.fileId, index);
    const item = el('li', 'calendar-item');
    item.dataset.fileId = calendar.fileId;

    const handle = el('button', 'icon-btn drag-handle');
    handle.type = 'button';
    handle.innerHTML = ICONS.grip;
    handle.title = 'Drag to reorder (or use the arrow keys)';
    handle.setAttribute(
      'aria-label',
      `Move ${calendar.displayName}, position ${position + 1} of ${ordered.length}. ` +
        'Use the up and down arrow keys.',
    );
    handle.addEventListener('keydown', (e) => {
      const to = e.key === 'ArrowUp' ? position - 1 : e.key === 'ArrowDown' ? position + 1 : -1;
      if (to < 0 || to >= ordered.length) return;
      e.preventDefault();
      focusAfterRender = calendar.fileId;
      moveCalendar(orderedIds, position, to);
    });
    handle.addEventListener('pointerdown', (e) => startDrag(e, handle, list, orderedIds));

    const visible = el('input');
    visible.type = 'checkbox';
    visible.checked = settings.visible;
    visible.setAttribute('aria-label', `Show ${calendar.displayName}`);
    visible.addEventListener('change', () =>
      updateCalendarSettings(calendar.fileId, index, { visible: visible.checked }),
    );

    const color = el('input', 'calendar-color');
    color.type = 'color';
    color.value = settings.color;
    color.setAttribute('aria-label', `Color of ${calendar.displayName}`);
    color.addEventListener('change', () =>
      updateCalendarSettings(calendar.fileId, index, { color: color.value }),
    );

    const subscription = subscriptionOf(calendar.fileId);
    const name = el('span', 'calendar-name', calendar.displayName);
    name.title = `${calendar.name}${calendar.dirty ? ' (unsaved changes)' : ''}`;
    if (calendar.dirty) name.classList.add('is-dirty');

    const label = el('label', 'calendar-label');
    label.append(visible, name);
    if (subscription) {
      const host = hostOf(subscription.url);
      const badge = el('span', 'subscription-badge');
      badge.innerHTML = ICONS.link;
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', 'Subscribed calendar');
      badge.title =
        `Subscribed to ${host} (read-only)\n` +
        `Last updated: ${subscription.lastUpdate?.toLocaleString(undefined, { hour12: false }) ?? 'never'}`;
      label.appendChild(badge);
    }

    const refreshing = state.refreshing.includes(calendar.fileId);
    const refresh = iconButton(
      'refresh',
      subscription
        ? `Update ${calendar.displayName} from ${hostOf(subscription.url)}`
        : `Refresh ${calendar.displayName} from Google Drive`,
      () => actions.onRefreshCalendar(calendar.fileId),
    );
    refresh.disabled = refreshing || state.status === 'loading' || state.fromCache;
    if (refreshing) refresh.classList.add('is-spinning');
    const rename = iconButton('edit', `Rename ${calendar.displayName}`, () =>
      actions.onRenameCalendar(calendar.fileId),
    );

    const tools = el('span', 'calendar-tools');
    tools.append(rename, refresh);
    item.append(handle, color, label, tools);
    list.appendChild(item);
  });
  nodes.push(list);

  if (state.folderId) {
    const add = el('div', 'calendar-add');
    add.append(
      button('+ New calendar', 'btn btn-small', actions.onNewCalendar),
      button('+ Subscribe', 'btn btn-small', actions.onSubscribe),
    );
    add.lastElementChild!.setAttribute(
      'title',
      'Add an online calendar (e.g. your university timetable) from its .ics link',
    );
    nodes.push(add);
  }

  if (state.warnings.length) {
    const warnings = el('ul', 'sidebar-warnings');
    for (const warning of state.warnings) warnings.appendChild(el('li', undefined, warning));
    nodes.push(warnings);
  }
  return nodes;
}

function renderOptions(actions: SidebarActions): HTMLElement[] {
  const offline = el('input');
  offline.type = 'checkbox';
  offline.checked = getSettings().offlineCache;
  offline.addEventListener('change', () => actions.onToggleOfflineCache(offline.checked));
  const offlineLabel = el('label', 'option-label');
  offlineLabel.append(offline, el('span', undefined, 'Keep an offline copy on this device'));
  offlineLabel.title =
    'Stores your calendars in this browser so the agenda opens instantly and stays readable ' +
    'when Google Drive is unreachable.';

  const proxy = getSettings().corsProxy;
  const proxyButton = button(
    proxy ? `CORS proxy: ${hostOf(proxy.replace('{url}', ''))}` : 'CORS proxy for subscriptions…',
    'link-btn',
    actions.onSetCorsProxy,
  );
  proxyButton.title =
    'Only needed when an online calendar refuses downloads from a web page (CORS errors).';

  return [
    el('h2', 'sidebar-title', 'Options'),
    offlineLabel,
    proxyButton,
    button('Keyboard shortcuts  ( ? )', 'link-btn', actions.onShowShortcuts),
  ];
}

export function mountSidebar(host: HTMLElement, actions: SidebarActions): Sidebar {
  const searchSection = el('section', 'sidebar-section search-section');
  const folderSection = el('section', 'sidebar-section');
  const calendarsSection = el('section', 'sidebar-section');
  const optionsSection = el('section', 'sidebar-section');
  host.replaceChildren(searchSection, folderSection, calendarsSection, optionsSection);

  // The search box is mounted once so typing isn't interrupted by re-renders.
  const search = mountSearch(searchSection, actions.onPickSearchResult);

  const render = () => {
    const state = getCalendarState();
    folderSection.replaceChildren(...renderFolder(actions, state));
    calendarsSection.replaceChildren(...renderCalendars(actions, state));
    optionsSection.replaceChildren(...renderOptions(actions));
    if (focusAfterRender) {
      calendarsSection
        .querySelector<HTMLElement>(
          `li[data-file-id="${CSS.escape(focusAfterRender)}"] .drag-handle`,
        )
        ?.focus();
      focusAfterRender = null;
    }
  };
  render();
  const offCalendars = onCalendarsChange(render);
  const offSettings = onSettingsChange(render);

  return {
    focusSearch: () => search.focus(),
    destroy: () => {
      offCalendars();
      offSettings();
      search.destroy();
      host.replaceChildren();
    },
  };
}
