/**
 * Where calendars and settings are stored. The app only talks to this interface; the Google Drive
 * implementation is in googleDrive/.
 *
 * File IDs and folder IDs are opaque strings chosen by the provider.
 */
export interface StorageProvider {
  /** Stable identifier, e.g. "google-drive". */
  readonly id: string;
  /** Name shown to the user, e.g. "Google Drive". */
  readonly label: string;

  /**
   * Finds the folder at `folderPath` (provider-specific syntax, e.g. "Agendas/ics") and lists the
   * .ics files in it. Throws a readable error if the folder doesn't exist.
   */
  listFiles(folderPath: string): Promise<FileListing>;
  /** The content of a file, as text. */
  download(fileId: string): Promise<string>;
  /** Replaces a file's content; returns its new metadata (with the new modifiedTime). */
  upload(fileId: string, content: string): Promise<FileMeta>;
  /** Current metadata of a file (used to detect changes made elsewhere before saving). */
  getMeta(fileId: string): Promise<FileMeta>;
  /** Creates a new file in a folder returned by listFiles. */
  create(folderId: string, name: string, content: string): Promise<FileMeta>;

  /** The app settings (JSON), or null if none were saved yet. */
  readSettings(): Promise<unknown>;
  writeSettings(settings: unknown): Promise<void>;

  /** The signed-in account. */
  getUser(): Promise<StorageUser>;
  /** Forgets cached state (on sign-out, before another account may sign in). */
  reset(): void;
}

export interface FileMeta {
  id: string;
  name: string;
  /** Changes whenever the file changes (any string the provider can compare). */
  modifiedTime: string;
}

export interface FileListing {
  /** ID of the resolved folder, to create files in it. */
  folderId: string;
  /** The .ics files of the folder, sorted by name. */
  files: FileMeta[];
}

export interface StorageUser {
  displayName: string;
  email: string;
  photoUrl?: string;
}
