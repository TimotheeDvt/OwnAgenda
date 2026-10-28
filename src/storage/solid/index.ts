import { markSolidSessionExpired, rememberedSolidAccount, solidFetch } from '../../auth/solidAuth';
import { SOLID_SETTINGS_PATH } from '../../config';
import { splitPath } from '../googleDrive/files';
import type { FileMeta, StorageProvider } from '../types';
import { LDP_CONTAINS, objectsOf, parseProfile, parseTurtle, type SolidProfile } from './rdf';

export class SolidError extends Error {
  override name = 'SolidError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Last known ETag of each file, sent as If-Match so the pod refuses to overwrite newer data. */
const etags = new Map<string, string>();
let profile: SolidProfile | null = null;
/** Replaced in tests. */
let send: Fetch = solidFetch;

export function setSolidFetch(next: Fetch): void {
  send = next;
}

function describe(res: Response, url: string): string {
  if (res.status === 401) return 'Your Solid session expired. Tap "Reconnect" to continue.';
  if (res.status === 403) {
    return `Your pod refused access to ${url}. Check that OwnAgenda was allowed to read and write when you signed in.`;
  }
  return `Solid pod error ${res.status}: ${res.statusText || 'request failed'} (${url})`;
}

/** fetch() with the Solid session. Throws SolidError for any non-2xx response. */
async function podFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await send(url, init);
  if (res.status === 401) markSolidSessionExpired();
  if (!res.ok) throw new SolidError(describe(res, url), res.status);
  return res;
}

/** A file's name: the last segment of its URL. */
function nameOf(url: string): string {
  const segment = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function getProfile(): Promise<SolidProfile> {
  if (profile) return profile;
  const webId = rememberedSolidAccount();
  if (!webId) throw new SolidError('Not signed in to a Solid pod.', 401);
  const res = await podFetch(webId, { headers: { Accept: 'text/turtle' } });
  profile = parseProfile(webId, await res.text());
  return profile;
}

/**
 * Folder URL for a path in settings: relative to the pod root ("calendars/work"), or a full URL
 * (which may also be another pod the user was given access to).
 */
async function folderUrl(path: string): Promise<string> {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  const segments = splitPath(trimmed);
  if (segments.length === 0) throw new SolidError('The folder path is empty.', 400);
  const { storage } = await getProfile();
  return `${storage}${segments.map(encodeURIComponent).join('/')}/`;
}

async function getMeta(url: string): Promise<FileMeta> {
  const res = await podFetch(url, { method: 'HEAD' });
  const etag = res.headers.get('ETag');
  if (etag) etags.set(url, etag);
  else etags.delete(url);
  return {
    id: url,
    name: nameOf(url),
    modifiedTime: etag ?? res.headers.get('Last-Modified') ?? '',
  };
}

async function put(url: string, body: string, contentType: string, condition: HeadersInit) {
  try {
    await podFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...condition },
      body,
    });
  } catch (err) {
    if (err instanceof SolidError && err.status === 412) {
      throw new SolidError(
        `${nameOf(url)} was changed somewhere else in the meantime. Reload it and try again.`,
        412,
      );
    }
    throw err;
  }
}

/**
 * A Solid pod (Solid Protocol, plain HTTP): calendars are .ics files in a container (folder) of
 * the pod, settings are a JSON file in the pod's private /settings/ folder. File IDs are URLs.
 */
export const solidProvider: StorageProvider = {
  id: 'solid',
  label: 'Solid pod',
  folderHelpHtml:
    'Path of the folder in your Solid pod that contains your <code>.ics</code> files, starting ' +
    'from the root of the pod. Use <code>/</code> between folders. A full folder URL works too.',
  folderPlaceholder: 'calendars',

  async listFiles(folderPath) {
    const url = await folderUrl(folderPath);
    let res: Response;
    try {
      res = await podFetch(url, { headers: { Accept: 'text/turtle' } });
    } catch (err) {
      if (err instanceof SolidError && err.status === 404) {
        throw new SolidError(`Folder "${folderPath}" was not found in your pod.`, 404);
      }
      throw err;
    }
    // The listing's subject is the folder itself, as the pod names it.
    const base = res.url || url;
    const quads = parseTurtle(await res.text(), base);
    const icsUrls = objectsOf(quads, base, LDP_CONTAINS).filter(
      (child) => !child.endsWith('/') && nameOf(child).toLowerCase().endsWith('.ics'),
    );
    // The listing has no ETags; they are needed to detect changes made elsewhere.
    const files = await Promise.all(icsUrls.map(getMeta));
    return { folderId: base, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
  },

  async download(fileId) {
    const res = await podFetch(fileId);
    return res.text();
  },

  async upload(fileId, content) {
    const etag = etags.get(fileId);
    await put(fileId, content, 'text/calendar; charset=utf-8', etag ? { 'If-Match': etag } : {});
    return getMeta(fileId);
  },

  getMeta,

  async create(folderId, name, content) {
    const url = `${folderId}${encodeURIComponent(name)}`;
    try {
      // If-None-Match: never replaces a file that already exists.
      await put(url, content, 'text/calendar; charset=utf-8', { 'If-None-Match': '*' });
    } catch (err) {
      if (err instanceof SolidError && err.status === 412) {
        throw new SolidError(`A file named "${name}" already exists in this folder.`, 412);
      }
      throw err;
    }
    return getMeta(url);
  },

  async readSettings() {
    const { storage } = await getProfile();
    let res: Response;
    try {
      res = await podFetch(`${storage}${SOLID_SETTINGS_PATH}`);
    } catch (err) {
      if (err instanceof SolidError && err.status === 404) return null;
      throw err;
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  },

  async writeSettings(settings) {
    const { storage } = await getProfile();
    await podFetch(`${storage}${SOLID_SETTINGS_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings, null, 2),
    });
  },

  async getUser() {
    const { webId, name, photo } = await getProfile();
    // The WebID identifies the account (it keys the offline copy); the pod's host is a readable
    // fallback name ("owncalendars.solidcommunity.net").
    return { displayName: name ?? new URL(webId).host, email: webId, photoUrl: photo ?? undefined };
  },

  reset() {
    profile = null;
    etags.clear();
  },
};
