import './styles/main.css';
import { startApp } from './ui/app';

void startApp(document.getElementById('app')!);

// Installable app: the service worker caches the app so it opens without network. Only in
// production builds; in development it would serve stale files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err: unknown) => {
      console.warn('Service worker registration failed', err);
    });
  });
}
