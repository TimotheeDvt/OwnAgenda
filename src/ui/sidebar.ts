import {
  getCalendarState,
  onCalendarsChange,
  subscriptionOf,
  type CalendarState,
} from '../store/calendarStore';
import {
  effectiveTextColor,
  getCalendarSettings,
  getSettings,
  moveCalendar,
  onSettingsChange,
  orderCalendars,
  updateCalendarSettings,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { openCalendarStylePicker } from './calendarStylePicker';
import { showSettingsDebug } from './settingsDebug';
import { ICONS, statusIcon, type IconName } from './icons';
import { mountSearch } from './search';

export interface SidebarActions {
  onChangeFolder(): void;
  onReload(): void;
  onRefreshCalendar(fileId: string): void;
  onRenameCalendar(fileId: string, name: string): void;
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

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "3 hours ago", "yesterday", "12 days ago"; "just now" under a minute. */
function timeAgo(date: Date, now = Date.now()): string {
  const elapsed = Math.max(0, now - date.getTime());
  for (const [unit, ms] of TIME_UNITS) {
    if (elapsed >= ms) return relativeTime.format(-Math.floor(elapsed / ms), unit);
  }
  return 'just now';
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
  // Changing folder needs the network: hidden while read-only (offline / session expired).
  if (!state.readOnly) {
    buttons.appendChild(
      iconButton('edit', path ? 'Change folder' : 'Set folder', actions.onChangeFolder),
    );
  }
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

/** Distance from the top/bottom edge of the scrolling panel where dragging scrolls it. */
const AUTO_SCROLL_EDGE_PX = 40;
const AUTO_SCROLL_STEP_PX = 12;

/**
 * Pointer-based drag (mouse, pen and touch alike): the row follows the pointer, passing over as
 * many rows as needed, and the panel scrolls near its edges. The new order is saved on release.
 *
 * The dragged row itself is never removed from the page (its neighbours are moved around it
 * instead): removing it would cancel the pointer capture and stop the drag after one step.
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
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    // Not critical: the window listeners below still follow the pointer.
  }
  const pointerId = e.pointerId;
  const scroller = list.closest<HTMLElement>('.sidebar-content');
  const from = [...list.children].indexOf(item);
  item.classList.add('is-dragging');
  list.classList.add('is-reordering');

  const middle = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    ev.preventDefault();
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      if (ev.clientY < bounds.top + AUTO_SCROLL_EDGE_PX) scroller.scrollTop -= AUTO_SCROLL_STEP_PX;
      else if (ev.clientY > bounds.bottom - AUTO_SCROLL_EDGE_PX) {
        scroller.scrollTop += AUTO_SCROLL_STEP_PX;
      }
    }
    // Moving up: move the rows above to just after the dragged one.
    let prev = item.previousElementSibling;
    while (prev && ev.clientY < middle(prev)) {
      list.insertBefore(prev, item.nextElementSibling);
      prev = item.previousElementSibling;
    }
    // Moving down: move the rows below to just before it.
    let next = item.nextElementSibling;
    while (next && ev.clientY > middle(next)) {
      list.insertBefore(next, item);
      next = item.nextElementSibling;
    }
  };
  const onEnd = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    item.classList.remove('is-dragging');
    list.classList.remove('is-reordering');
    const to = [...list.children].indexOf(item);
    if (to !== from) moveCalendar(orderedIds, from, to);
  };
  // On the window, so the drag keeps following the pointer wherever it goes.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
}

function renderCalendars(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  // Title line; a rotating arrow next to it while calendars load or update from storage.
  const title = el('h2', 'sidebar-title sidebar-title-row', 'Calendars');
  if (state.status === 'loading') {
    title.appendChild(
      statusIcon(
        'refresh',
        state.calendars.length ? 'Updating from Google Drive...' : 'Loading...',
        true,
      ),
    );
  }
  const nodes: HTMLElement[] = [title];
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

    // Eye toggle: open = shown in the calendar, closed = hidden.
    const visible = iconButton(
      settings.visible ? 'eye' : 'eyeOff',
      `${settings.visible ? 'Hide' : 'Show'} ${calendar.displayName}`,
      () => updateCalendarSettings(calendar.fileId, index, { visible: !settings.visible }),
    );
    visible.classList.add('visibility-toggle');
    visible.setAttribute('aria-pressed', String(settings.visible));
    if (!settings.visible) item.classList.add('is-hidden');

    // Color square with the calendar's icon inside; opens the color & icon picker.
    const color = el('button', 'calendar-color', settings.icon);
    color.type = 'button';
    color.style.background = settings.color;
    // Font icons take the text color: dark or white, whichever reads best on the square.
    color.style.color = effectiveTextColor(settings);
    color.setAttribute('aria-label', `Name, color and icon of ${calendar.displayName}`);
    color.title = 'Change name, color and icon';
    color.addEventListener('click', () =>
      openCalendarStylePicker({
        anchor: color,
        calendarName: calendar.displayName,
        color: settings.color,
        icon: settings.icon,
        textColor: settings.textColor,
        onChange: (patch) => updateCalendarSettings(calendar.fileId, index, patch),
        // Renaming changes the file: not while read-only.
        onRename: state.readOnly
          ? undefined
          : (newName) => actions.onRenameCalendar(calendar.fileId, newName),
      }),
    );

    const subscription = subscriptionOf(calendar.fileId);
    const name = el('span', 'calendar-name', calendar.displayName);
    name.title = `${calendar.name}${calendar.dirty ? ' (unsaved changes)' : ''}`;
    if (calendar.dirty) name.classList.add('is-dirty');

    const label = el('span', 'calendar-label');
    label.append(name);
    const lastUpdated = subscription
      ? `Last updated: ${subscription.lastUpdate ? timeAgo(subscription.lastUpdate) : 'never'}`
      : '';
    if (subscription) {
      const host = hostOf(subscription.url);
      const badge = el('span', 'subscription-badge');
      badge.innerHTML = ICONS.link;
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', 'Subscribed calendar');
      badge.title = `Subscribed to ${host} (read-only)\n${lastUpdated}`;
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
    if (subscription) refresh.title += `\n${lastUpdated}`;

    const tools = el('span', 'calendar-tools');
    // Read-only (offline / session expired): only showing/hiding stays available.
    if (state.readOnly) tools.append(visible);
    else tools.append(visible, refresh);
    item.append(handle, color, label, tools);
    list.appendChild(item);
  });
  nodes.push(list);

  if (state.warnings.length) {
    const warnings = el('ul', 'sidebar-warnings');
    for (const warning of state.warnings) warnings.appendChild(el('li', undefined, warning));
    nodes.push(warnings);
  }
  return nodes;
}

/** Buttons to add a calendar, once a Drive folder is loaded (they create files in it). */
function renderAddButtons(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  if (!state.folderId || state.readOnly) return [];
  const subscribe = button('+ Subscribe', 'btn btn-small', actions.onSubscribe);
  subscribe.title = 'Add an online calendar (e.g. your university timetable) from its .ics link';
  return [button('+ New calendar', 'btn btn-small', actions.onNewCalendar), subscribe];
}

/** Icon-only tools pinned to the bottom of the sidebar, sharing its full width. */
function renderFooter(actions: SidebarActions): HTMLElement[] {
  const shortcuts = iconButton('keyboard', 'Keyboard shortcuts (?)', actions.onShowShortcuts);

  // Offline copy toggle: highlighted when on.
  const offlineOn = getSettings().offlineCache;
  const offline = iconButton(
    'database',
    `Offline copy on this device: ${offlineOn ? 'ON' : 'OFF'}\n` +
      'Keeps your calendars in this browser so the agenda opens instantly and stays readable ' +
      'when Google Drive is unreachable. Signing out deletes it.\n' +
      `Click to turn it ${offlineOn ? 'off' : 'on'}.`,
    () => actions.onToggleOfflineCache(!offlineOn),
  );
  offline.setAttribute('aria-label', 'Keep an offline copy on this device');
  offline.setAttribute('aria-pressed', String(offlineOn));
  offline.classList.toggle('is-on', offlineOn);

  const proxy = getSettings().corsProxy;
  const proxyButton = iconButton(
    'globe',
    proxy
      ? `CORS proxy for subscriptions: ${hostOf(proxy.replace('{url}', ''))}`
      : 'CORS proxy for subscriptions (only needed when an online calendar refuses downloads)',
    actions.onSetCorsProxy,
  );
  // A dot shows that a proxy is set.
  proxyButton.classList.toggle('is-active', Boolean(proxy));

  // Dev server only (`npm run dev`): left out of production builds.
  if (import.meta.env.DEV) {
    const debug = iconButton('bug', 'Debug: show the settings file', showSettingsDebug);
    return [offline, proxyButton, shortcuts, debug];
  }
  return [offline, proxyButton, shortcuts];
}

export function mountSidebar(host: HTMLElement, actions: SidebarActions): Sidebar {
  const searchSection = el('section', 'sidebar-section search-section');
  const folderSection = el('section', 'sidebar-section');
  const calendarsSection = el('section', 'sidebar-section');
  // Sections scroll; the footer stays glued to the bottom of the panel.
  const content = el('div', 'sidebar-content');
  content.append(searchSection, folderSection, calendarsSection);
  // "New calendar" / "Subscribe", fixed just above the footer icons.
  const addBar = el('div', 'sidebar-add');
  const footer = el('div', 'sidebar-footer');
  host.replaceChildren(content, addBar, footer);

  // The search box is mounted once so typing isn't interrupted by re-renders.
  const search = mountSearch(searchSection, actions.onPickSearchResult);

  const render = () => {
    const state = getCalendarState();
    folderSection.replaceChildren(...renderFolder(actions, state));
    calendarsSection.replaceChildren(...renderCalendars(actions, state));
    addBar.replaceChildren(...renderAddButtons(actions, state));
    addBar.hidden = addBar.childElementCount === 0;
    footer.replaceChildren(...renderFooter(actions));
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
