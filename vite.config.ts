import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo-name>/. CI passes VITE_BASE derived from the
// repository name; the fallback matches this repo's name.
const REPO_BASE = '/OwnAgenda/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.VITE_BASE ?? REPO_BASE) : '/',
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
