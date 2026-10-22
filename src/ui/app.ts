import { initAuth, isSignedIn, onAuthChange, signIn, signOut } from '../auth/auth';
import { resetAppDataCache } from '../drive/appData';
import { getCurrentUser, type DriveUser } from '../drive/files';
import {
  clearCalendars,
  createCalendar,
  errorMessage,
  getCalendarState,
  hasUnsavedChanges,
  isCalendarDirty,
  loadCalendars,
  loadFromCache,
  onCalendarsChange,
  refreshCalendar,
  renameCalendar,
  retrySaves,
  setConflictHandler,
  setSaveErrorHandler,
  setSubscriptionErrorHandler,
  subscribeCalendar,
  subscriptionOf,
  syncStaleSubscriptions,
  syncSubscription,
  snapshotFiles,
  type CalendarState,
} from '../store/calendarStore';
import { clearSnapshot, readSnapshot, writeSnapshot } from '../store/offlineCache';
import {
  applyCachedSettings,
  flushSettings,
  getSettings,
  loadSettings,
  normalizeSettings,
  onSettingsChange,
  onSettingsSaveError,
  resetSettings,
  updateSettings,
  type Theme,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { mountCalendarView, type CalendarView } from './calendarView';
import { chooseOption } from './choiceDialog';
import { createEventNow, openEvent } from './eventActions';
import { ICONS } from './icons';
import { installShortcuts, showShortcutsHelp } from './shortcuts';
import { mountSidebar, type Sidebar } from './sidebar';
import { setupSidebarResize } from './sidebarResize';
import { promptFolderPath, promptForm, promptText } from './textPrompt';
import { applyTheme, cachedTheme, mountThemeSwitch } from './theme';
import { showToast } from './toast';

interface Layout {
  menu: HTMLButtonElement;
  saveStatus: HTMLElement;
  theme: HTMLButtonElement;
  user: HTMLElement;
  sidebar: HTMLElement;
  backdrop: HTMLElement;
  resizer: HTMLElement;
  main: HTMLElement;
}

const SNAPSHOT_DEBOUNCE_MS = 1500;

let layout: Layout;
let calendarView: CalendarView | null = null;
let sidebar: Sidebar | null = null;
/** Incremented on every auth transition so stale async work can bail out. */
let session = 0;
/** Account of the signed-in user, used to key the offline copy. */
let accountEmail: string | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

function renderLayout(root: HTMLElement): Layout {
  root.innerHTML = `
    <header class="app-header">
      <button type="button" class="icon-btn menu-btn" aria-label="Show calendars" hidden>☰</button>
      <h1 class="app-title">ICS Agenda</h1>
      <div class="header-actions">
        <div class="save-status" aria-live="polite"></div>
        <button class="theme-switch"></button>
        <div class="header-user"></div>
      </div>
    </header>
    <div class="app-body">
      <aside class="sidebar" id="sidebar" aria-label="Calendars"></aside>
      <div class="sidebar-resizer"></div>
      <div class="sidebar-backdrop"></div>
      <main class="calendar-host"></main>
    </div>`;
  return {
    menu: root.querySelector('.menu-btn')!,
    saveStatus: root.querySelector('.save-status')!,
    theme: root.querySelector('.theme-switch')!,
    user: root.querySelector('.header-user')!,
    sidebar: root.querySelector('.sidebar')!,
    backdrop: root.querySelector('.sidebar-backdrop')!,
    resizer: root.querySelector('.sidebar-resizer')!,
    main: root.querySelector('.calendar-host')!,
  };
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------------------------------------------------------------------------------------------
// Header

function renderUser(user: DriveUser | null): void {
  const nodes: Node[] = [];
  if (user) {
    if (user.photoLink) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = user.photoLink;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      nodes.push(img);
    }
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = user.displayName || user.emailAddress;
    name.title = user.emailAddress;
    nodes.push(name);
  }
  const signOutButton = button('', 'icon-btn header-icon-btn', () => void handleSignOut());
  signOutButton.innerHTML = ICONS.logout;
  signOutButton.setAttribute('aria-label', 'Sign out');
  signOutButton.title = 'Sign out';
  nodes.push(signOutButton);
  layout.user.replaceChildren(...nodes);
}

const SAVE_LABELS: Record<CalendarState['saveStatus'], string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'All changes saved',
  unsaved: 'Unsaved changes',
  error: 'Not saved',
};

function renderSaveStatus(state: CalendarState): void {
  const el = layout.saveStatus;
  el.dataset.state = state.saveStatus;
  const label = document.createElement('span');
  label.textContent = SAVE_LABELS[state.saveStatus];
  if (state.saveError) label.title = state.saveError;
  const nodes: Node[] = [label];
  if (state.saveStatus === 'error' || state.saveStatus === 'unsaved') {
    nodes.push(button('Retry', 'btn btn-small', retrySaves));
  }
  el.replaceChildren(...nodes);
}

function setTheme(theme: Theme): void {
  applyTheme(theme);
  if (isSignedIn() && getSettings().theme !== theme) updateSettings({ theme });
}

// ---------------------------------------------------------------------------------------------
// Sidebar drawer (narrow screens)

function setDrawer(open: boolean): void {
  document.body.classList.toggle('sidebar-open', open);
  layout.menu.setAttribute('aria-expanded', String(open));
}

// ---------------------------------------------------------------------------------------------
// Screens

function renderSignedOut(): void {
  layout.user.replaceChildren(button('Sign in with Google', 'btn btn-primary', handleSignIn));
  layout.sidebar.hidden = true;
  layout.menu.hidden = true;
  setDrawer(false);
  const welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.innerHTML = `
    <h2>Your .ics calendars, from Google Drive</h2>
    <p>Sign in with Google to load every <code>.ics</code> file from a folder in your Drive.</p>`;
  welcome.appendChild(button('Sign in with Google', 'btn btn-primary', handleSignIn));
  layout.main.replaceChildren(welcome);
}

function renderFatal(message: string): void {
  const box = document.createElement('div');
  box.className = 'welcome';
  const title = document.createElement('h2');
  title.textContent = 'Something went wrong';
  const text = document.createElement('p');
  text.textContent = message;
  box.append(title, text);
  layout.main.replaceChildren(box);
}

// ---------------------------------------------------------------------------------------------
// Actions

/** Asks before an action that would drop unsaved calendar changes. */
async function confirmDiscard(action: string, dirty = hasUnsavedChanges()): Promise<boolean> {
  if (!dirty) return true;
  const choice = await chooseOption(
    'Unsaved changes',
    `Some changes haven't been saved to Google Drive yet. ${action} anyway and lose them?`,
    [
      { value: 'cancel', label: 'Cancel' },
      { value: 'discard', label: 'Discard changes', kind: 'danger' },
    ],
  );
  return choice === 'discard';
}

async function handleSignIn(): Promise<void> {
  try {
    await signIn();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
}

async function handleSignOut(): Promise<void> {
  if (!(await confirmDiscard('Sign out'))) return;
  try {
    await flushSettings();
  } catch {
    // Signing out anyway; the last setting change is lost.
  }
  // Signing out explicitly also removes the offline copy from this device.
  await clearSnapshot();
  signOut();
}

async function changeFolder(firstRun = false): Promise<void> {
  const path = await promptFolderPath(getSettings().folderPath, firstRun);
  if (!path) return;
  if (!(await confirmDiscard('Change folder'))) return;
  if (path !== getSettings().folderPath) updateSettings({ folderPath: path });
  await loadCalendars(path);
}

/** Re-lists the folder and downloads every calendar again from Drive. */
async function reloadAll(): Promise<void> {
  const { folderPath } = getSettings();
  if (!folderPath || getCalendarState().status === 'loading') return;
  if (!(await confirmDiscard('Reload'))) return;
  await loadCalendars(folderPath);
  const state = getCalendarState();
  if (state.status === 'ready' && !state.fromCache) {
    showToast(`${state.calendars.length} calendar(s) reloaded from Google Drive.`, 'success');
  }
}

async function refreshOne(fileId: string): Promise<void> {
  const calendar = getCalendarState().calendars.find((c) => c.fileId === fileId);
  if (!calendar) return;
  // Subscribed calendar: download it again from its online source right now.
  if (subscriptionOf(fileId)) {
    try {
      await syncSubscription(fileId, { force: true });
      showToast(`"${calendar.displayName}" was updated from its online calendar.`, 'success');
    } catch (err) {
      showToast(`Could not update "${calendar.displayName}": ${errorMessage(err)}`, 'error');
    }
    return;
  }
  if (!(await confirmDiscard(`Refresh "${calendar.displayName}"`, isCalendarDirty(fileId)))) {
    return;
  }
  try {
    const result = await refreshCalendar(fileId);
    showToast(
      result === 'updated'
        ? `"${calendar.displayName}" was updated from Google Drive.`
        : `"${calendar.displayName}" is up to date.`,
      'success',
    );
  } catch (err) {
    showToast(`Could not refresh "${calendar.displayName}": ${errorMessage(err)}`, 'error');
  }
}

async function subscribe(): Promise<void> {
  const values = await promptForm({
    title: 'Subscribe to an online calendar',
    descriptionHtml:
      "Paste the calendar's <code>.ics</code> link (for AMU: in ADE, open your timetable, " +
      "click <em>Export</em> / <em>Exporter l'agenda</em> and copy the generated URL). " +
      'A copy is saved as a new <code>.ics</code> file in your folder and updated every day. ' +
      'Its events are read-only.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'AMU lessons' },
      { name: 'url', label: 'Calendar link', type: 'url', placeholder: 'https://… or webcal://…' },
    ],
    submitLabel: 'Subscribe',
  });
  if (!values?.name || !values.url) return;
  try {
    await subscribeCalendar(values.name, values.url);
    showToast(`Subscribed to "${values.name}".`, 'success');
  } catch (err) {
    showToast(`Could not subscribe: ${errorMessage(err)}`, 'error');
  }
}

async function setCorsProxy(): Promise<void> {
  const values = await promptForm({
    title: 'CORS proxy for subscriptions',
    descriptionHtml:
      'Some calendar servers refuse downloads from a web page. A CORS proxy fetches the ' +
      'calendar for the app. Use <code>{url}</code> where the calendar link goes, e.g. ' +
      '<code>https://my-proxy.example.workers.dev/?url={url}</code>. ' +
      '<strong>The proxy sees your calendar link and its contents</strong>, so use one you ' +
      'trust (ideally your own). Leave empty to download directly.',
    fields: [
      {
        name: 'proxy',
        label: 'Proxy URL',
        type: 'url',
        value: getSettings().corsProxy,
        placeholder: 'https://…/?url={url}',
        optional: true,
      },
    ],
  });
  if (!values) return;
  updateSettings({ corsProxy: values.proxy ?? '' });
}

async function newCalendar(): Promise<void> {
  const name = await promptText({
    title: 'New calendar',
    descriptionHtml: `A new <code>.ics</code> file will be created in your folder on Google Drive.`,
    label: 'Name',
    placeholder: 'Family',
    submitLabel: 'Create',
  });
  if (!name) return;
  try {
    await createCalendar(name);
    showToast(`Calendar "${name}" created.`, 'success');
  } catch (err) {
    showToast(`Could not create the calendar: ${errorMessage(err)}`, 'error');
  }
}

async function renameOne(fileId: string): Promise<void> {
  const calendar = getCalendarState().calendars.find((c) => c.fileId === fileId);
  if (!calendar) return;
  const name = await promptText({
    title: 'Rename calendar',
    descriptionHtml:
      'The name is stored in the calendar file (<code>X-WR-CALNAME</code>); the file name on ' +
      'Google Drive stays the same.',
    label: 'Name',
    value: calendar.displayName,
  });
  if (!name || name === calendar.displayName) return;
  try {
    renameCalendar(fileId, name);
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
}

function pickSearchResult(event: AgendaEvent): void {
  setDrawer(false);
  calendarView?.showEvent(event);
  void openEvent(event);
}

async function toggleOfflineCache(enabled: boolean): Promise<void> {
  updateSettings({ offlineCache: enabled });
  if (enabled) scheduleSnapshot();
  else await clearSnapshot();
}

// ---------------------------------------------------------------------------------------------
// Offline copy

function scheduleSnapshot(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (!isSignedIn() || !accountEmail || !getSettings().offlineCache) return;
    const files = snapshotFiles();
    if (!files) return;
    void writeSnapshot({
      email: accountEmail,
      settings: getSettings(),
      files,
      savedAt: new Date().toISOString(),
    });
  }, SNAPSHOT_DEBOUNCE_MS);
}

/** Shows the offline copy of this account (if any) while Drive loads. Returns true if shown. */
async function showOfflineCopy(user: DriveUser | null): Promise<boolean> {
  const snapshot = await readSnapshot();
  if (!snapshot) return false;
  if (user && snapshot.email !== user.emailAddress) {
    // Another account used this browser before: never show its data.
    await clearSnapshot();
    return false;
  }
  if (!normalizeSettings(snapshot.settings).offlineCache) return false;
  accountEmail = snapshot.email;
  applyCachedSettings(snapshot.settings);
  loadFromCache(snapshot.files);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Session

function mountMain(): void {
  if (sidebar) return;
  applyTheme(getSettings().theme);
  sidebar = mountSidebar(layout.sidebar, {
    onChangeFolder: () => void changeFolder(),
    onReload: () => void reloadAll(),
    onRefreshCalendar: (fileId) => void refreshOne(fileId),
    onRenameCalendar: (fileId) => void renameOne(fileId),
    onNewCalendar: () => void newCalendar(),
    onSubscribe: () => void subscribe(),
    onSetCorsProxy: () => void setCorsProxy(),
    onPickSearchResult: pickSearchResult,
    onToggleOfflineCache: (enabled) => void toggleOfflineCache(enabled),
    onShowShortcuts: showShortcutsHelp,
  });
  layout.main.replaceChildren();
  calendarView = mountCalendarView(layout.main);
}

async function enterSignedIn(): Promise<void> {
  const current = ++session;
  renderUser(null);
  layout.sidebar.hidden = false;
  layout.menu.hidden = false;
  layout.main.replaceChildren();

  let user: DriveUser | null = null;
  try {
    user = await getCurrentUser();
    accountEmail = user.emailAddress;
  } catch {
    // Offline or Drive hiccup: the header just shows the sign-out button.
  }
  if (current !== session) return;
  if (user) renderUser(user);

  // Show the offline copy right away, then replace it with fresh data from Drive.
  if (await showOfflineCopy(user)) {
    if (current !== session) return;
    mountMain();
  }

  let settingsLoaded = true;
  try {
    await loadSettings();
  } catch (err) {
    settingsLoaded = false;
    if (!getCalendarState().fromCache) {
      showToast(`Could not load settings: ${errorMessage(err)}`, 'error');
    }
  }
  if (current !== session) return;
  if (settingsLoaded) {
    applyTheme(getSettings().theme);
  }
  mountMain();

  const { folderPath } = getSettings();
  if (folderPath) await loadCalendars(folderPath);
  // Only treat this as a first run when settings really loaded and have no folder.
  else if (settingsLoaded) await changeFolder(true);
}

function enterSignedOut(): void {
  session++;
  accountEmail = null;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  calendarView?.destroy();
  calendarView = null;
  sidebar?.destroy();
  sidebar = null;
  clearCalendars();
  resetSettings();
  resetAppDataCache();
  renderSignedOut();
}

function setupSaving(): void {
  setConflictHandler(async (calendar) => {
    const choice = await chooseOption(
      'Calendar changed on Drive',
      `"${calendar.displayName}" was changed somewhere else since it was loaded. ` +
        'Reload it from Drive (your changes to this calendar are lost), or overwrite the ' +
        'Drive version with yours?',
      [
        { value: 'later', label: 'Decide later' },
        { value: 'reload', label: 'Reload' },
        { value: 'overwrite', label: 'Overwrite', kind: 'primary' },
      ],
    );
    return choice ?? 'later';
  });
  setSubscriptionErrorHandler((calendar, message) =>
    showToast(
      `Could not update "${calendar.displayName}" from its online calendar: ${message}`,
      'warning',
      10_000,
    ),
  );
  // Subscriptions are checked when calendars load, and again whenever the tab becomes visible
  // (switching back to it, waking the computer): that's when fresh data matters.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (isSignedIn() && getCalendarState().status === 'ready') void syncStaleSubscriptions();
  });
  setSaveErrorHandler((calendar, message) =>
    showToast(`Could not save "${calendar.displayName}": ${message}`, 'error'),
  );
  onCalendarsChange((state) => {
    renderSaveStatus(state);
    scheduleSnapshot();
  });
  onSettingsChange(() => scheduleSnapshot());
  renderSaveStatus(getCalendarState());

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges()) e.preventDefault();
  });
}

function setupShortcuts(): void {
  const whenReady = (action: (view: CalendarView) => void) => () => {
    if (calendarView) action(calendarView);
  };
  installShortcuts({
    today: whenReady((v) => v.today()),
    prev: whenReady((v) => v.prev()),
    next: whenReady((v) => v.next()),
    changeView: (view) => calendarView?.changeView(view),
    newEvent: whenReady(() => void createEventNow()),
    focusSearch: () => {
      if (!sidebar) return;
      setDrawer(true);
      sidebar.focusSearch();
    },
    reloadAll: () => void reloadAll(),
  });
}

export async function startApp(root: HTMLElement): Promise<void> {
  layout = renderLayout(root);
  const theme = cachedTheme();
  applyTheme(theme);
  mountThemeSwitch(layout.theme, setTheme);
  layout.menu.addEventListener('click', () =>
    setDrawer(!document.body.classList.contains('sidebar-open')),
  );
  layout.backdrop.addEventListener('click', () => setDrawer(false));
  setupSidebarResize(layout.resizer, () => calendarView?.updateSize());
  layout.menu.setAttribute('aria-controls', 'sidebar');

  onSettingsSaveError((err) => showToast(`Could not save settings: ${errorMessage(err)}`, 'error'));
  setupSaving();
  setupShortcuts();

  try {
    await initAuth();
  } catch (err) {
    renderFatal(errorMessage(err));
    return;
  }

  onAuthChange((signedIn) => (signedIn ? void enterSignedIn() : enterSignedOut()));
  if (isSignedIn()) await enterSignedIn();
  else renderSignedOut();
}
