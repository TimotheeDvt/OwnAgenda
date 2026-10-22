import { readSettings, resetAppDataCache, writeSettings } from './appData';
import {
  createFile,
  downloadFile,
  getCurrentUser,
  getFileMeta,
  listIcsFiles,
  resolvePath,
  uploadFile,
  type DriveFileMeta,
} from './files';
import type { FileMeta, StorageProvider } from '../types';

const toMeta = ({ id, name, modifiedTime }: DriveFileMeta): FileMeta => ({
  id,
  name,
  modifiedTime,
});

/**
 * Google Drive (API v3): calendars are .ics files in a folder of My Drive, settings are a hidden
 * settings.json in the app's appDataFolder. The Drive API code lives next to this file.
 */
export const googleDriveProvider: StorageProvider = {
  id: 'google-drive',
  label: 'Google Drive',

  async listFiles(folderPath) {
    const folderId = await resolvePath(folderPath);
    const files = await listIcsFiles(folderId);
    return { folderId, files: files.map(toMeta) };
  },
  download: (fileId) => downloadFile(fileId),
  upload: async (fileId, content) => toMeta(await uploadFile(fileId, content)),
  getMeta: async (fileId) => toMeta(await getFileMeta(fileId)),
  create: async (folderId, name, content) => toMeta(await createFile(folderId, name, content)),

  readSettings: () => readSettings(),
  writeSettings: (settings) => writeSettings(settings),

  async getUser() {
    const user = await getCurrentUser();
    return { displayName: user.displayName, email: user.emailAddress, photoUrl: user.photoLink };
  },
  reset: () => resetAppDataCache(),
};
