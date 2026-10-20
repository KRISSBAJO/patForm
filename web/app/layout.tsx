import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Pwa } from '../components/pwa';

export const metadata: Metadata = {
  title: 'Patform — expenses, procurement, HR, appraisals, IT, contracts and e-signature on one engine',
  description:
    'Eight modules on one engine with one history: expenses, procurement, HR, goals and appraisals, assets and IT, contracts and compliance, and Patform Sign, a built-in e-signature with a certificate seal and trusted time stamp.',
  openGraph: {
    title: 'Patform',
    description: 'A process platform for operational teams.',
    type: 'website',
  },
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Patform' },
};

export const viewport: Viewport = {
  themeColor: '#f7f5f0',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Dancing+Script:wght@500&family=Great+Vibes&family=Caveat:wght@500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <Pwa />
      </body>
    </html>
  );
}
