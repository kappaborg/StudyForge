import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor shell config. The native iOS + Android projects (under
 * ``ios/`` and ``android/`` after running ``npx cap add ios|android``)
 * package a webview that loads the live web URL below.
 *
 * Two modes documented in ``MOBILE.md``:
 *   1. **Remote shell** (this default) — webview points at the production
 *      Vercel deployment. Fast iteration: a web push ships to mobile users
 *      on the next app open. Apple's reviewers ask pointed questions about
 *      "just-a-webview" apps; the mitigations (native splash, deep links,
 *      offline mode via the existing PWA service worker) are documented.
 *   2. **Bundled shell** — toggle ``server.url`` off + run ``next export``
 *      style static build into ``apps/mobile/www/``. Slower to ship updates,
 *      but no app-store review pushback. See ``MOBILE.md`` for the toggle.
 */

const config: CapacitorConfig = {
  appId: 'ai.studyforge.app',
  appName: 'StudyForge',
  webDir: 'www',

  server: {
    // Live URL. Comment this whole ``server`` block to fall back to the
    // bundled ``www/`` directory (see ``MOBILE.md`` bundled-shell mode).
    url: 'https://study-forge-web.vercel.app',
    cleartext: false,
    allowNavigation: [
      // The webview is allowed to navigate within the production
      // hostname (Google OAuth redirects, share-links, etc.).
      'study-forge-web.vercel.app',
      // Google OAuth's hosted consent screen — required so the
      // "Continue with Google" button doesn't error with
      // ``ERR_BLOCKED_BY_CLIENT``.
      'accounts.google.com',
    ],
  },

  ios: {
    contentInset: 'always',
    // Disable inline media playback by default — Apple wants explicit
    // user gestures for autoplay or the review eats us.
    allowsLinkPreview: false,
  },

  android: {
    // ``adjustResize`` so the soft keyboard doesn't cover input fields
    // in the chat / search surfaces.
    backgroundColor: '#000000',
  },

  plugins: {
    SplashScreen: {
      // Match the web app's dark / light handling. Native splash screen
      // is the only thing visible during cold boot before the webview
      // attaches; keep it short so the perceived load time stays low.
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      // Match the dark theme that ships by default.
      style: 'DARK',
      backgroundColor: '#000000',
    },
  },
};

export default config;
