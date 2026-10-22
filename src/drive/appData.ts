import { DRIVE_API, DRIVE_UPLOAD_API, SETTINGS_FILE_NAME } from '../config';
import { buildUrl, createWithContent, driveFetch, driveJson } from './driveClient';

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

  const created = await createWithContent<{ id: string }>(
    { name: SETTINGS_FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' },
    body,
    'id',
  );
  settingsFileId = created.id;
}

/** Forgets the cached file ID (on sign-out: another account has its own appDataFolder). */
export function resetAppDataCache(): void {
  settingsFileId = null;
}
