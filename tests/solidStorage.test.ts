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

  it('loads a folder with one request per file', async () => {
    for (const name of ['a', 'b', 'c']) pod.put(`${POD}calendars/${name}.ics`, name);
    const { files } = await solidProvider.listFiles('calendars');
    const before = pod.requests.length;
    expect(await Promise.all(files.map((f) => solidProvider.download(f.id)))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(pod.requests.length).toBe(before);
    // Profile + folder + 3 files.
    expect(pod.requests.length).toBe(5);
  });

  it('sends at most 4 requests at once', async () => {
    for (let i = 0; i < 12; i++) pod.put(`${POD}calendars/c${i}.ics`, `${i}`);
    let inFlight = 0;
    let peak = 0;
    setSolidFetch(async (url, init) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return pod.fetch(url, init);
    });
    const { files } = await solidProvider.listFiles('calendars');
    expect(files).toHaveLength(12);
    expect(peak).toBe(4);
  });

  describe('when the pod drops requests', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      return () => vi.useRealTimers();
    });

    /** Fails the first `failures` requests to `url` like a dropped request. */
    function flaky(url: string, failures: number, error: () => Promise<Response>) {
      let left = failures;
      setSolidFetch((u, init) => (u === url && left-- > 0 ? error() : pod.fetch(u, init)));
    }
    const dropped = () => Promise.reject(new TypeError('Failed to fetch'));

    it('retries reads, and the calendar loads', async () => {
      pod.put(`${POD}calendars/work.ics`, 'W');
      flaky(`${POD}calendars/work.ics`, 2, dropped);
      const listing = solidProvider.listFiles('calendars');
      await vi.runAllTimersAsync();
      const { files } = await listing;
      expect(await solidProvider.download(files[0]!.id)).toBe('W');
    });

    it('retries busy answers (429)', async () => {
      pod.put(`${POD}calendars/work.ics`, 'W');
      flaky(`${POD}calendars/work.ics`, 1, async () => new Response('', { status: 429 }));
      const listing = solidProvider.listFiles('calendars');
      await vi.runAllTimersAsync();
      expect((await listing).files[0]?.modifiedTime).toMatch(/^"\d+"$/);
    });

    it('keeps listing the other files, and explains the one that failed', async () => {
      pod.put(`${POD}calendars/work.ics`, 'W');
      pod.put(`${POD}calendars/home.ics`, 'H');
      flaky(`${POD}calendars/work.ics`, 10, dropped);
      const listing = solidProvider.listFiles('calendars');
      await vi.runAllTimersAsync();
      const { files } = await listing;
      expect(files.map((f) => f.name)).toEqual(['home.ics', 'work.ics']);
      expect(await solidProvider.download(files[0]!.id)).toBe('H');
      await expect(solidProvider.download(files[1]!.id)).rejects.toThrow(
        /Could not reach work\.ics on your pod.*permissions/,
      );
    });

    it('never repeats a save that got no answer (it may have been applied)', async () => {
      pod.put(`${POD}calendars/work.ics`, 'W');
      const listing = solidProvider.listFiles('calendars');
      await vi.runAllTimersAsync();
      const id = (await listing).files[0]!.id;
      let puts = 0;
      setSolidFetch((u, init) => {
        if (init?.method === 'PUT') {
          puts++;
          return dropped();
        }
        return pod.fetch(u, init);
      });
      const upload = solidProvider.upload(id, 'mine');
      const failed = expect(upload).rejects.toThrow('Could not reach work.ics');
      await vi.runAllTimersAsync();
      await failed;
      expect(puts).toBe(1);
    });
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
