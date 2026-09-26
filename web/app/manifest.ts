import type { MetadataRoute } from 'next';

/**
 * What makes the console installable.
 *
 * The public form is not in here on purpose: a respondent fills it once
 * from a link. The console and the builder are the daily tools, and an
 * approver on a phone wants the console on the home screen with a badge
 * and a notification, not a bookmark.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Patform',
    short_name: 'Patform',
    description: 'Approvals, records and the work waiting for you.',
    id: '/console',
    start_url: '/console',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f4f3f0',
    theme_color: '#1f5c3a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'My work', url: '/console', description: 'Decisions and tasks waiting for you' },
      { name: 'Builder', url: '/builder', description: 'Change a process' },
    ],
  };
}
