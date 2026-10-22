import { DRIVE_API, DRIVE_UPLOAD_API } from '../config';
import { buildUrl, createWithContent, driveFetch, driveJson } from './driveClient';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime: string;
  mimeType?: string;
}

interface FileList {
  files: DriveFileMeta[];
  nextPageToken?: string;
}

export interface DriveUser {
  displayName: string;
  emailAddress: string;
  photoLink?: string;
}

export class PathError extends Error {
  override name = 'PathError';
}

/** Escapes a value for use inside a single-quoted Drive query string. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Splits "Agendas/ics" into ["Agendas", "ics"], ignoring empty segments and extra slashes. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Walks the folder path from My Drive root and returns the last folder's ID. */
export async function resolvePath(path: string): Promise<string> {
  const segments = splitPath(path);
  if (segments.length === 0) throw new PathError('The folder path is empty.');

  let parentId = 'root';
  const walked: string[] = [];
  for (const segment of segments) {
    const list = await driveJson<FileList>(
      buildUrl(`${DRIVE_API}/files`, {
        q:
          `name='${escapeQuery(segment)}' and '${escapeQuery(parentId)}' in parents` +
          ` and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: 'files(id,name)',
        pageSize: 10,
        spaces: 'drive',
      }),
    );
    const folder = list.files[0];
    if (!folder) {
      const where = walked.length ? `"${walked.join('/')}"` : 'My Drive';
      throw new PathError(`Folder "${segment}" was not found in ${where}.`);
    }
    walked.push(segment);
    parentId = folder.id;
  }
  return parentId;
}

/** Lists every non-trashed file in the folder whose name ends in ".ics", sorted by name. */
export async function listIcsFiles(folderId: string): Promise<DriveFileMeta[]> {
  const result: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const list = await driveJson<FileList>(
      buildUrl(`${DRIVE_API}/files`, {
        q:
          `'${escapeQuery(folderId)}' in parents and trashed=false` +
          ` and mimeType!='${FOLDER_MIME}' and name contains '.ics'`,
        fields: 'nextPageToken,files(id,name,modifiedTime,mimeType)',
        pageSize: 1000,
        spaces: 'drive',
        pageToken,
      }),
    );
    result.push(...list.files.filter((f) => f.name.toLowerCase().endsWith('.ics')));
    pageToken = list.nextPageToken;
  } while (pageToken);
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function downloadFile(fileId: string): Promise<string> {
  const res = await driveFetch(
    buildUrl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { alt: 'media' }),
  );
  return res.text();
}

export function getFileMeta(fileId: string): Promise<DriveFileMeta> {
  return driveJson<DriveFileMeta>(
    buildUrl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      fields: 'id,name,modifiedTime,mimeType',
    }),
  );
}

/** Replaces the file's content and returns its updated metadata (including the new modifiedTime). */
export function uploadFile(fileId: string, content: string): Promise<DriveFileMeta> {
  return driveJson<DriveFileMeta>(
    buildUrl(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}`, {
      uploadType: 'media',
      fields: 'id,name,modifiedTime,mimeType',
    }),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: content,
    },
  );
}

/** Creates a new .ics file in the folder and returns its metadata. */
export function createFile(
  folderId: string,
  name: string,
  content: string,
): Promise<DriveFileMeta> {
  return createWithContent<DriveFileMeta>(
    { name, parents: [folderId], mimeType: 'text/calendar' },
    content,
    'id,name,modifiedTime,mimeType',
  );
}

/** The signed-in user, via Drive's about endpoint (no extra profile scope needed). */
export async function getCurrentUser(): Promise<DriveUser> {
  const about = await driveJson<{ user: DriveUser }>(
    buildUrl(`${DRIVE_API}/about`, { fields: 'user(displayName,emailAddress,photoLink)' }),
  );
  return about.user;
}
