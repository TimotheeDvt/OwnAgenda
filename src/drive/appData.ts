import { DRIVE_API, DRIVE_UPLOAD_API, SETTINGS_FILE_NAME } from '../config';
import { buildUrl, driveFetch, driveJson } from './driveClient';

let settingsFileId: string | null = null;

async function findSettingsFileId(): Promise<string | null> {
  if (settingsFileId) return settingsFileId;
  const list = await driveJson<{ files: { id: string }[] }>(
    buildUrl(`${DRIVE_API}/files`, {
      spaces: 'appDataFolder',
      q: `name='${SETTINGS_FILE_NAME}' and trashed=false`,
      fields: 'files(id)',
      pageSize: 1,
    }),
  );
  settingsFileId = list.files[0]?.id ?? null;
  return settingsFileId;
}

/** Reads settings.json from the appDataFolder. Returns null on first run or if it isn't JSON. */
export async function readSettings(): Promise<unknown> {
  const id = await findSettingsFileId();
  if (!id) return null;
  const res = await driveFetch(buildUrl(`${DRIVE_API}/files/${id}`, { alt: 'media' }));
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Creates or overwrites settings.json in the appDataFolder. */
export async function writeSettings(settings: unknown): Promise<void> {
  const body = JSON.stringify(settings, null, 2);
  const id = await findSettingsFileId();
  if (id) {
    await driveFetch(buildUrl(`${DRIVE_UPLOAD_API}/files/${id}`, { uploadType: 'media' }), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return;
  }

  const boundary = `ics-agenda-${crypto.randomUUID()}`;
  const metadata = {
    name: SETTINGS_FILE_NAME,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  };
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const created = await driveJson<{ id: string }>(
    buildUrl(`${DRIVE_UPLOAD_API}/files`, { uploadType: 'multipart', fields: 'id' }),
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    },
  );
  settingsFileId = created.id;
}

/** Forgets the cached file ID (on sign-out: another account has its own appDataFolder). */
export function resetAppDataCache(): void {
  settingsFileId = null;
}
