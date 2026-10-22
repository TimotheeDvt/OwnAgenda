# OwnAgenda

A calendar web app for your own `.ics` files.

Your calendars are plain `.ics` files in a Google Drive folder. OwnAgenda signs in with Google, loads every calendar in that folder, and shows them together in one agenda. Edits are written straight back to the files. There is no backend and no database: the files stay in your Drive, and the app is a static site that runs in your browser.

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
- Keyboard shortcuts (press `?` in the app to list them)
- Installable as a PWA

## Running locally

Requirements: Node.js 24+ and a Google Cloud project.

### 1. Create a Google OAuth client

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Enable the **Google Drive API**.
2. Set up the OAuth consent screen and add yourself as a test user.
3. Create an **OAuth client ID** of type **Web application**, and add `http://localhost:5173` under authorized JavaScript origins.

The app requests the `drive` and `drive.appdata` scopes. It needs them to read `.ics` files it didn't create and to store its settings in a hidden app folder.

### 2. Configure and start

```sh
npm install
cp .env.example .env.local   # then set VITE_GOOGLE_CLIENT_ID
npm run dev
```

Open http://localhost:5173, sign in, and choose the Drive folder that holds your `.ics` files.

### Other scripts

| Command           | What it does                         |
| ----------------- | ------------------------------------ |
| `npm run build`   | Type-check and build into `dist/`    |
| `npm run preview` | Serve the production build           |
| `npm test`        | Run the test suite (Vitest)          |
| `npm run lint`    | Lint with ESLint                     |
| `npm run format`  | Format with Prettier                 |
| `npm run icons`   | Regenerate the PWA icons             |

## Deployment

Each push to `main` builds the site and deploys it to GitHub Pages (see [.github/workflows/deploy.yml](.github/workflows/deploy.yml)). Set `VITE_GOOGLE_CLIENT_ID` as a repository variable, and add the Pages URL to the OAuth client's authorized origins.
