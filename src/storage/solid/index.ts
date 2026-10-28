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

/**
 * The browser only says "Failed to fetch" when a request gets no readable answer: no network,
 * the pod being down, or a refusal the browser hides from the page. Say what to check instead.
 */
function unreachable(url: string): SolidError {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new SolidError("You're offline.", 0);
  }
  return new SolidError(
    `Could not reach ${nameOf(url) || url} on your pod (the pod may be busy: try again). If it ` +
      "keeps failing, check the folder's permissions (.acl): your WebID needs Read and Write, " +
      'applied to the contained resources too.',
    0,
  );
}

/**
 * Requests in flight at once. Pods (and the proxies in front of them) drop bursts: loading a
 * folder of 15 calendars in parallel made some downloads fail at random.
 */
const MAX_PARALLEL = 4;
/** Extra attempts after a failure the pod may recover from, waiting 0.5 s, then 1 s. */
const RETRIES = 2;
const RETRY_DELAY_MS = 500;
/** "Busy, try later" answers: the request was not processed. */
const BUSY_STATUSES = new Set([429, 502, 503, 504]);

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await task();
  } finally {
    // Hand the slot straight to the next request, or free it.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() with the Solid session, a few requests at a time. Reads are retried after a network
 * failure or a busy answer; writes only after a busy answer (a write that got no answer may have
 * been applied, and repeating it would look like a conflict). Throws SolidError for any non-2xx
 * response.
 */
async function podFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < RETRIES;
    let res: Response;
    try {
      res = await withSlot(() => send(url, init));
    } catch (err) {
      // Not signed in (AuthError) keeps its own message; network failures are TypeErrors.
      if (!(err instanceof TypeError)) throw err;
      if (!(canRetry && isRead && navigator.onLine !== false)) throw unreachable(url);
      await sleep(RETRY_DELAY_MS * 2 ** attempt);
      continue;
    }
    if (canRetry && BUSY_STATUSES.has(res.status)) {
      await sleep(RETRY_DELAY_MS * 2 ** attempt);
      continue;
    }
    if (res.status === 401) markSolidSessionExpired();
    if (!res.ok) throw new SolidError(describe(res, url), res.status);
    return res;
  }
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

/**
 * Files downloaded while listing the folder (or why that failed), handed to the download() that
 * follows: loading a folder costs one request per file instead of two.
 */
const prefetched = new Map<string, { body: string } | { error: unknown }>();

async function getMeta(url: string): Promise<FileMeta> {
  return metaOf(url, await podFetch(url, { method: 'HEAD' }));
}

function metaOf(url: string, res: Response): FileMeta {
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
    // The listing has no ETags (needed to detect changes made elsewhere): each file is
    // downloaded now, and its content kept for download(). A file that fails is still listed,
    // so only that calendar shows a warning.
    prefetched.clear();
    const files = await Promise.all(
      icsUrls.map(async (fileUrl) => {
        try {
          const fileRes = await podFetch(fileUrl);
          prefetched.set(fileUrl, { body: await fileRes.text() });
          return metaOf(fileUrl, fileRes);
        } catch (error) {
          prefetched.set(fileUrl, { error });
          return { id: fileUrl, name: nameOf(fileUrl), modifiedTime: '' };
        }
      }),
    );
    return { folderId: base, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
  },

  async download(fileId) {
    const early = prefetched.get(fileId);
    if (early) {
      prefetched.delete(fileId);
      if ('error' in early) throw early.error;
      return early.body;
    }
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
    prefetched.clear();
  },
};
