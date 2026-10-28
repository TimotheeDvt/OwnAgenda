import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Solid provider runs against a fake pod (no network, no sign-in).
vi.mock('../src/auth/solidAuth', () => ({
  markSolidSessionExpired: vi.fn(),
  rememberedSolidAccount: () => 'https://alice.pod.test/profile/card#me',
  solidFetch: vi.fn(),
}));

const { setSolidFetch, solidProvider } = await import('../src/storage/solid');
const { parseProfile } = await import('../src/storage/solid/rdf');

const POD = 'https://alice.pod.test/';
const PROFILE = `
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix space: <http://www.w3.org/ns/pim/space#>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
<#me> foaf:name "Alice"; space:storage <../>; solid:oidcIssuer <https://idp.test/>.`;

interface PodFile {
  body: string;
  etag: number;
}

/** A tiny in-memory pod: GET/HEAD/PUT with ETags, If-Match and If-None-Match. */
function fakePod() {
  const files = new Map<string, PodFile>();
  let tick = 1;
  const requests: { method: string; url: string; headers: Headers }[] = [];
  const listing = (folder: string) =>
    [...files.keys()]
      .filter((u) => u.startsWith(folder) && !u.slice(folder.length).includes('/'))
      .map((u) => `<> <http://www.w3.org/ns/ldp#contains> <${u.slice(folder.length)}>.`)
      .join('\n');

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({ method, url, headers });
    if (url === `${POD}profile/card#me`) return new Response(PROFILE);
    if (url.endsWith('/')) {
      if (![...files.keys()].some((u) => u.startsWith(url)))
        return new Response('', { status: 404 });
      return new Response(listing(url));
    }
    const file = files.get(url);
    if (method === 'PUT') {
      const ifMatch = headers.get('If-Match');
      if (headers.get('If-None-Match') === '*' && file) return new Response('', { status: 412 });
      if (ifMatch && file && ifMatch !== `"${file.etag}"`) return new Response('', { status: 412 });
      files.set(url, { body: String(init.body), etag: ++tick });
      return new Response('', { status: 201 });
    }
    if (!file) return new Response('', { status: 404 });
    return new Response(method === 'HEAD' ? null : file.body, {
      headers: { ETag: `"${file.etag}"` },
    });
  };
  return {
    files,
    requests,
    fetch,
    put: (url: string, body: string) => files.set(url, { body, etag: ++tick }),
  };
}

let pod: ReturnType<typeof fakePod>;

beforeEach(() => {
  pod = fakePod();
  setSolidFetch(pod.fetch);
  solidProvider.reset();
});

describe('Solid profile', () => {
  it('reads the name, pod root and provider of a WebID', () => {
    const profile = parseProfile(`${POD}profile/card#me`, PROFILE);
    expect(profile).toMatchObject({ name: 'Alice', storage: POD, issuer: 'https://idp.test/' });
  });
});

describe('Solid storage', () => {
  it('lists only the .ics files of the folder, sorted, with their ETags', async () => {
    pod.put(`${POD}calendars/work.ics`, 'W');
    pod.put(`${POD}calendars/Family%20life.ics`, 'F');
    pod.put(`${POD}calendars/notes.txt`, 'N');
    pod.put(`${POD}calendars/old/archive.ics`, 'A');

    const { folderId, files } = await solidProvider.listFiles('calendars');
    expect(folderId).toBe(`${POD}calendars/`);
    expect(files.map((f) => f.name)).toEqual(['Family life.ics', 'work.ics']);
    expect(files[1]?.modifiedTime).toMatch(/^"\d+"$/);
    expect(await solidProvider.download(files[1]!.id)).toBe('W');
  });

  it('explains when the folder does not exist', async () => {
    await expect(solidProvider.listFiles('missing')).rejects.toThrow(
      'Folder "missing" was not found in your pod.',
    );
  });

  it('refuses to overwrite a file changed elsewhere since it was read', async () => {
    pod.put(`${POD}calendars/work.ics`, 'v1');
    const { files } = await solidProvider.listFiles('calendars');
    const id = files[0]!.id;
    pod.put(id, 'changed on another device');

    await expect(solidProvider.upload(id, 'mine')).rejects.toThrow('changed somewhere else');
    // After looking at the new version (the app asks first), overwriting works.
    await solidProvider.getMeta(id);
    const meta = await solidProvider.upload(id, 'mine');
    expect(pod.files.get(id)?.body).toBe('mine');
    expect(meta.modifiedTime).toBe(`"${pod.files.get(id)?.etag}"`);
  });

  it('never replaces an existing file when creating one', async () => {
    pod.put(`${POD}calendars/work.ics`, 'W');
    const folder = `${POD}calendars/`;
    await expect(solidProvider.create(folder, 'work.ics', 'X')).rejects.toThrow('already exists');
    const created = await solidProvider.create(folder, 'New one.ics', 'N');
    expect(created).toMatchObject({ id: `${folder}New%20one.ics`, name: 'New one.ics' });
  });

  it('keeps settings in the private settings folder of the pod', async () => {
    expect(await solidProvider.readSettings()).toBeNull();
    await solidProvider.writeSettings({ folderPath: 'calendars' });
    expect(pod.files.has(`${POD}settings/ownagenda.json`)).toBe(true);
    expect(await solidProvider.readSettings()).toEqual({ folderPath: 'calendars' });
  });

  it('uses the WebID as the account and the profile name for display', async () => {
    expect(await solidProvider.getUser()).toEqual({
      displayName: 'Alice',
      email: `${POD}profile/card#me`,
      photoUrl: undefined,
    });
  });
});
