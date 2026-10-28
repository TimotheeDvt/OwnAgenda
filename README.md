# OwnAgenda

A calendar web app for your own `.ics` files.

Your calendars are plain `.ics` files in a folder of your own storage: a [Solid pod](https://solidproject.org) or Google Drive. OwnAgenda signs in to that storage, loads every calendar in the folder, and shows them together in one agenda. Edits are written straight back to the files. There is no backend and no database: the files stay in your storage, and the app is a static site that runs in your browser.

| Storage      | Open source                                                 | Setup for the app              |
| ------------ | ----------------------------------------------------------- | ------------------------------ |
| Solid pod    | Yes: open W3C protocol, open-source servers, free providers | None                           |
| Google Drive | No                                                          | A Google Cloud OAuth client ID |

## Features

- Month, week, day and list views
- Create, edit, move, duplicate and delete events, including recurring ones (this event / this and following / all events)
- Undo and redo changes
- Create new calendars, and give each one its own color and icon
- Subscribe to online calendars by their `.ics` link. A read-only copy is saved in your folder and refreshed daily. An optional CORS proxy handles servers that block browser requests
- Time zone support
- Search across all events
- Copy the current view to the clipboard as an image
- Offline copy of your last loaded calendars, so the app opens instantly and still works without a connection
- Light and dark themes
- Export and import settings (colors, icons, order, views, faded events…) to move them to another storage. Calendars are matched by file name; the folder path is not included
- Keyboard shortcuts (press `?` in the app to list them)
- Installable as a PWA

## Using a Solid pod

### 1. Get a pod

Create a free pod with one of the [providers listed by the Solid Project](https://solidproject.org/users/get-a-pod), for example [solidcommunity.net](https://solidcommunity.net/). You get:

- a **pod**, your storage: `https://<name>.solidcommunity.net/`
- a **WebID**, your identity: `https://<name>.solidcommunity.net/profile/card#me`

### 2. Put your `.ics` files in a folder of the pod

1. Open [Penny](https://penny.vincenttunru.com/), a file browser for Solid pods, and sign in with your provider (`https://solidcommunity.net`).
2. Open your pod, create a folder, for example `calendars`, and upload your `.ics` files into it.
3. Check that the folder is private: open `https://<name>.solidcommunity.net/calendars/` in a private browser window. It must ask you to sign in, or show an "Unauthorized" error. If it lists your files, change the folder's permissions (its `.acl`) so that only you can read it. Note that the list of folder _names_ at the pod root is public, so don't put anything personal in a folder name.

You can also skip uploading: an empty folder is fine, and the app's "New calendar" button creates `.ics` files in it.

### 3. Sign in to OwnAgenda

1. Click **Sign in with Solid** and enter your provider (`https://solidcommunity.net`) or your WebID.
2. Sign in on the provider's page and allow OwnAgenda to read and write. You are then sent back to the app.
3. When asked for the folder, enter its path from the pod root (`calendars`), or the folder's full URL.

The app keeps its settings in your pod's private `settings/` folder (`settings/ownagenda.json`). Each time the app opens online, it renews the Solid session with a quick redirect to the provider and back. Offline, it opens read-only from the copy on the device.

### Moving from Google Drive

1. In Google Drive, download every `.ics` file of your folder, and upload them to your pod's folder. Subscribed calendars are ordinary `.ics` files that contain their link, so they keep updating after the move.
2. Signed in with Google, click **Export settings** at the bottom of the sidebar.
3. Sign out, sign in with Solid, choose the pod folder, then click **Import settings** and pick the exported file. Calendars are matched by file name, and your Solid folder path stays as it is.

Saves use the file's ETag (`If-Match`), so the pod itself refuses to overwrite a calendar that was changed on another device in the meantime.

## Running locally

Requirements: Node.js 24+. A Google Cloud project only if you want Google Drive: without `VITE_GOOGLE_CLIENT_ID`, the app offers Solid only.

### 1. Create a Google OAuth client (optional, for Google Drive)

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Enable the **Google Drive API**.
2. Set up the OAuth consent screen and add yourself as a test user.
3. Create an **OAuth client ID** of type **Web application**, and add `http://localhost:5173` under authorized JavaScript origins.

The app requests the `drive` and `drive.appdata` scopes. It needs them to read `.ics` files it didn't create and to store its settings in a hidden app folder.

### 2. Configure and start

```sh
npm install
cp .env.example .env.local   # then set VITE_GOOGLE_CLIENT_ID, or remove it for Solid only
npm run dev
```

Open http://localhost:5173, sign in with Solid or Google, and choose the folder that holds your `.ics` files.

### Other scripts

| Command           | What it does                      |
| ----------------- | --------------------------------- |
| `npm run build`   | Type-check and build into `dist/` |
| `npm run preview` | Serve the production build        |
| `npm test`        | Run the test suite (Vitest)       |
| `npm run lint`    | Lint with ESLint                  |
| `npm run format`  | Format with Prettier              |
| `npm run icons`   | Regenerate the PWA icons          |

## Deployment

Each push to `main` builds the site and deploys it to GitHub Pages (see [.github/workflows/deploy.yml](.github/workflows/deploy.yml)). For Google Drive, set `VITE_GOOGLE_CLIENT_ID` as a repository variable, and add the Pages URL to the OAuth client's authorized origins. Solid needs no configuration: the app registers itself with the provider at sign-in.
