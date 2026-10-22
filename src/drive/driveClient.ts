import { getAccessToken, refreshAccessToken } from '../auth/auth';

export class DriveError extends Error {
  override name = 'DriveError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type QueryValue = string | number | boolean | undefined;

export function buildUrl(base: string, params: Record<string, QueryValue> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function describeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return `Google Drive error ${res.status}: ${body.error.message}`;
  } catch {
    // Body wasn't JSON; fall through to the status text.
  }
  return `Google Drive error ${res.status}: ${res.statusText || 'request failed'}`;
}

/**
 * fetch() with the Drive access token. On 401, gets a fresh token and retries once.
 * Throws DriveError for any non-2xx response.
 */
export async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers });
  };

  let res = await send(await getAccessToken());
  if (res.status === 401) res = await send(await refreshAccessToken());
  if (!res.ok) throw new DriveError(await describeError(res), res.status);
  return res;
}

export async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await driveFetch(url, init);
  return (await res.json()) as T;
}
