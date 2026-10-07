// The one tool scripts/build-offline.mjs writes a service worker for: this site, served from the root of its host.
// Passed to it with `--tools scripts/offline-tools.mjs` (npm run build does).
export const TOOLS = [
  {
    id: 'chambers-finder',
    scope: '/',
    swPath: '/sw.js',
    pages: ['/'],
    // Everything the page needs is on this site: the postcode table is a fingerprinted file the page preloads
    // (so the build finds it), and the QR library the share dialog loads lazily is named in app.js.
    extra: ['/manifest.json', '/img/pwa-192.png', '/img/pwa-512.png', '/img/pwa-maskable-512.png', '/img/apple-touch-icon.png'],
    essentialFonts: [],
    // The court and chambers data is edited in place and fetched by a fixed path, so it is never listed with a
    // hash: the worker fetches it from the network first and keeps the last copy for when there is none.
    live: ['/finder-data.json'],
    // Offline, a mistyped address shows the site's own not-found page.
    notFound: '/404.html',
  },
];
