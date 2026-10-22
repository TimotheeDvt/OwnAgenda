import { initAuth, isSignedIn, onAuthChange, signIn, signOut } from '../auth/auth';
import { resetAppDataCache } from '../drive/appData';
import { getCurrentUser, type DriveUser } from '../drive/files';
import {
  clearCalendars,
  errorMessage,
  getCalendarState,
  hasUnsavedChanges,
  loadCalendars,
  onCalendarsChange,
  retrySaves,
  setConflictHandler,
  setSaveErrorHandler,
  type CalendarState,
} from '../store/calendarStore';
import {
  flushSettings,
  getSettings,
  loadSettings,
  onSettingsSaveError,
  resetSettings,
  updateSettings,
  type Theme,
} from '../store/settingsStore';
import { mountCalendarView, type CalendarView } from './calendarView';
import { chooseOption } from './choiceDialog';
import { promptFolderPath } from './folderPrompt';
import { mountSidebar } from './sidebar';
import { applyTheme, cachedTheme } from './theme';
import { showToast } from './toast';

interface Layout {
  saveStatus: HTMLElement;
  theme: HTMLSelectElement;
  user: HTMLElement;
  sidebar: HTMLElement;
  main: HTMLElement;
}

let layout: Layout;
let calendarView: CalendarView | null = null;
let unmountSidebar: (() => void) | null = null;
/** Incremented on every auth transition so stale async work can bail out. */
let session = 0;

function renderLayout(root: HTMLElement): Layout {
  root.innerHTML = `
    <header class="app-header">
      <h1 class="app-title">ICS Agenda</h1>
      <div class="header-actions">
        <div class="save-status" aria-live="polite"></div>
        <select class="theme-select" aria-label="Theme">
          <option value="system">System theme</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <div class="header-user"></div>
      </div>
    </header>
    <div class="app-body">
      <aside class="sidebar" aria-label="Calendars"></aside>
      <main class="calendar-host"></main>
    </div>`;
  return {
    saveStatus: root.querySelector('.save-status')!,
    theme: root.querySelector('.theme-select')!,
    user: root.querySelector('.header-user')!,
    sidebar: root.querySelector('.sidebar')!,
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
  nodes.push(button('Sign out', 'btn', () => void handleSignOut()));
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
  layout.theme.value = theme;
  if (isSignedIn() && getSettings().theme !== theme) updateSettings({ theme });
}

function renderSignedOut(): void {
  layout.user.replaceChildren(button('Sign in with Google', 'btn btn-primary', handleSignIn));
  layout.sidebar.hidden = true;
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

/** Asks before an action that would drop unsaved calendar changes. */
async function confirmDiscard(action: string): Promise<boolean> {
  if (!hasUnsavedChanges()) return true;
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
  signOut();
}

async function changeFolder(firstRun = false): Promise<void> {
  const path = await promptFolderPath(getSettings().folderPath, firstRun);
  if (!path) return;
  if (!(await confirmDiscard('Change folder'))) return;
  if (path !== getSettings().folderPath) updateSettings({ folderPath: path });
  await loadCalendars(path);
}

async function reloadAll(): Promise<void> {
  if (!(await confirmDiscard('Reload'))) return;
  await loadCalendars(getSettings().folderPath);
}

async function enterSignedIn(): Promise<void> {
  const current = ++session;
  renderUser(null);
  layout.sidebar.hidden = false;
  layout.main.replaceChildren();

  getCurrentUser()
    .then((user) => current === session && renderUser(user))
    .catch(() => {
      // Not critical: the header just shows the sign-out button.
    });

  let settingsLoaded = true;
  try {
    await loadSettings();
  } catch (err) {
    settingsLoaded = false;
    showToast(`Could not load settings: ${errorMessage(err)}`, 'error');
  }
  if (current !== session) return;

  if (settingsLoaded) {
    applyTheme(getSettings().theme);
    layout.theme.value = getSettings().theme;
  }

  unmountSidebar = mountSidebar(layout.sidebar, {
    onChangeFolder: () => void changeFolder(),
    onReload: () => void reloadAll(),
  });
  calendarView = mountCalendarView(layout.main);

  const { folderPath } = getSettings();
  if (folderPath) await loadCalendars(folderPath);
  // Only treat this as a first run when settings really loaded and have no folder.
  else if (settingsLoaded) await changeFolder(true);
}

function enterSignedOut(): void {
  session++;
  calendarView?.destroy();
  calendarView = null;
  unmountSidebar?.();
  unmountSidebar = null;
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
  setSaveErrorHandler((calendar, message) =>
    showToast(`Could not save "${calendar.displayName}": ${message}`, 'error'),
  );
  onCalendarsChange(renderSaveStatus);
  renderSaveStatus(getCalendarState());

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges()) e.preventDefault();
  });
}

export async function startApp(root: HTMLElement): Promise<void> {
  layout = renderLayout(root);
  const theme = cachedTheme();
  applyTheme(theme);
  layout.theme.value = theme;
  layout.theme.addEventListener('change', () => setTheme(layout.theme.value as Theme));

  onSettingsSaveError((err) => showToast(`Could not save settings: ${errorMessage(err)}`, 'error'));
  setupSaving();

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
