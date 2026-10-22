import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo-name>/. CI passes VITE_BASE derived from the
// repository name; the fallback matches this repo's name.
const REPO_BASE = '/OwnAgenda/';

// The dev server runs at "/"; builds (and `npm run preview` of a build) use the Pages path.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.VITE_BASE ?? REPO_BASE) : '/',
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
