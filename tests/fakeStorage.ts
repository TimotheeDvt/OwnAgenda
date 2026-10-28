import type { FileMeta, StorageProvider } from '../src/storage';

interface StoredFile {
  name: string;
  content: string;
  modifiedTime: string;
}

/**
 * In-memory StorageProvider for tests: one folder of files plus settings. Every upload/create
 * gets a new modifiedTime ("t2", "t3"...), like a real store would.
 */
export class FakeStorage implements StorageProvider {
  readonly id = 'fake';
  readonly label = 'Fake storage';
  readonly folderHelpHtml = 'Folder path.';
  readonly folderPlaceholder = 'folder';
  readonly files = new Map<string, StoredFile>();
  uploads: string[] = [];
  settings: unknown = null;
  /** When true, listFiles fails like an unreachable server. */
  offline = false;
  /** When set, uploads fail with this error (e.g. an expired session). */
  uploadError: Error | null = null;
  private tick = 1;

  /** Replaces the folder content. */
  reset(): void {
    this.files.clear();
    this.uploads = [];
    this.offline = false;
    this.uploadError = null;
    this.tick = 1;
  }

  put(id: string, name: string, content: string, modifiedTime = 't1'): void {
    this.files.set(id, { name, content, modifiedTime });
  }

  private meta(id: string): FileMeta {
    const file = this.files.get(id);
    if (!file) throw new Error(`No file ${id}`);
    return { id, name: file.name, modifiedTime: file.modifiedTime };
  }

  async listFiles() {
    if (this.offline) throw new TypeError('Failed to fetch');
    const files = [...this.files.keys()].map((id) => this.meta(id));
    return { folderId: 'folder', files: files.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async download(fileId: string) {
    return this.files.get(fileId)!.content;
  }

  async upload(fileId: string, content: string) {
    if (this.uploadError) throw this.uploadError;
    const file = this.files.get(fileId)!;
    file.content = content;
    file.modifiedTime = `t${++this.tick}`;
    this.uploads.push(content);
    return this.meta(fileId);
  }

  async getMeta(fileId: string) {
    return this.meta(fileId);
  }

  async create(_folderId: string, name: string, content: string) {
    const id = `file-${this.files.size + 1}`;
    this.files.set(id, { name, content, modifiedTime: `t${++this.tick}` });
    return this.meta(id);
  }

  async readSettings() {
    return this.settings;
  }

  async writeSettings(settings: unknown) {
    this.settings = settings;
  }

  async getUser() {
    return { displayName: 'Test User', email: 'test@example.com' };
  }
}
