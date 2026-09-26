'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker on the pages that are the application: the
 * console and the builder. The landing page and the public form are left
 * alone; a respondent should not be offered an install of something they
 * will use once.
 *
 * The install prompt the browser fires is kept on `window` so the account
 * page can offer an Install button where the browser supports one, instead
 * of a banner over whatever the person was doing.
 */
declare global {
  interface Window {
    __patformInstall?: { prompt: () => Promise<unknown>; userChoice: Promise<{ outcome: string }> } | null;
  }
}

export function Pwa() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const path = window.location.pathname;
    if (!(path.startsWith('/console') || path.startsWith('/builder'))) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* an old browser, or a private window that refuses: the page works the same */
    });
    const onPrompt = (e: Event) => {
      e.preventDefault();
      window.__patformInstall = e as unknown as Window['__patformInstall'];
      window.dispatchEvent(new Event('patform:installable'));
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  return null;
}
