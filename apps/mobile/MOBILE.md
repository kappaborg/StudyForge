# Mobile shell — Capacitor wrap → App Store + Play Store

This package is the **iOS + Android native shell** that wraps the live
web app for store submission. It exists so testers can install StudyForge
from TestFlight / Play internal-testing instead of typing the Vercel URL
on a tiny screen.

The JS bits in this directory are minimal — `capacitor.config.ts` plus
a few npm scripts. The heavy native projects (`ios/` Xcode workspace,
`android/` Gradle project) are **generated on your first checkout** by
`npx cap add ios|android` so the repo doesn't carry hundreds of MB of
auto-regenerable scaffolding.

## Prereqs (one-time, per machine)

| Need | For | Install |
|---|---|---|
| Xcode 15+ | iOS build | App Store on a Mac |
| CocoaPods | iOS deps | `sudo gem install cocoapods` (or `brew install cocoapods`) |
| Android Studio | Android build | <https://developer.android.com/studio> |
| JDK 17 | Android build | bundled with Android Studio |

You'll also need a **paid developer account** for each store you submit to:

- Apple Developer Program — **$99/year**, sign up at <https://developer.apple.com/programs/>
- Google Play Console — **$25 one-time**, sign up at <https://play.google.com/console/signup>

## First-time setup

```bash
cd apps/mobile
pnpm install
npx cap add ios       # generates ios/ — commits to the repo
npx cap add android   # generates android/ — commits to the repo
```

That gives you native projects you can open in Xcode / Android Studio.
The webview already points at the live Vercel URL via
`capacitor.config.ts`, so the moment the projects build, you can run on
a simulator and the app loads the production web app.

## Iterating

Web changes ship through Vercel automatically (you push to `main`, Vercel
deploys, mobile webview picks it up on next cold start). Native changes
(icons, splash screen, native plugins, Info.plist, AndroidManifest.xml)
require a new native build.

```bash
# After editing capacitor.config.ts or any native config
pnpm cap:sync                # copies web assets + plugins into ios/android
pnpm cap:open:ios            # opens Xcode
pnpm cap:open:android        # opens Android Studio
```

## TestFlight (iOS)

1. In Xcode: **Product → Archive** (requires a real signing certificate
   from your Apple Developer account; Xcode walks you through it).
2. When the Organizer window opens with your archive selected, click
   **Distribute App → App Store Connect → Upload**.
3. Go to <https://appstoreconnect.apple.com>. Your build appears under
   **TestFlight** after ~15 min of processing.
4. Add internal testers (up to 100 by Apple ID). They install via the
   TestFlight app on their iPhone — no review required for internal.
5. For external testing (up to 10 000 testers) you need a one-time
   App Review pass — usually ~24 hours.

### App Store submission

1. In App Store Connect → **My Apps → New App**. Bundle ID must match
   `appId` in `capacitor.config.ts` (`ai.studyforge.app`).
2. Fill in: app name, subtitle, category (Education), age rating
   (4+ unless you turn on user-generated content surfaces).
3. Upload 6.7" + 6.5" iPhone screenshots (mandatory) and 12.9" iPad if
   you support tablet — take these in the simulator.
4. **Privacy questionnaire** is where most webview apps trip:
   - **Data linked to user**: email (Google OAuth), course content
     (uploaded materials), usage data (mastery / quiz attempts).
   - **Tracking across apps**: no (we don't use IDFA).
   - **Third-party SDKs**: list Sentry if you've enabled it.
5. **App Privacy → Data Use** section: declare every data point above
   under "Data linked to user." The Vercel URL serves the web app; data
   flows out are to your Render API, which is your own infrastructure.
6. Submit for review. Apple averages 24–48 hours. Common rejections for
   webview apps:
   - **4.2 Minimum Functionality**: respond by emphasizing the
     offline-capable PWA service worker, native push notifications
     (TODO — wire `@capacitor/push-notifications` first), and
     native-feeling splash screen / status bar integration.
   - **5.1.1 Data Collection**: the privacy questionnaire above must
     match what the live app actually does — otherwise rejected.

## Play internal-testing → production (Android)

1. In Android Studio: **Build → Generate Signed App Bundle**. Generate
   a new upload keystore (store the password in a password manager —
   losing it means publishing under a different identity).
2. Go to <https://play.google.com/console>. **Create app** → name
   `StudyForge`, default language English, app type "App", free.
3. **Testing → Internal testing → Create new release** → upload the
   `.aab` from step 1 → save → review release → roll out.
4. Add testers via their Gmail. They install through a Play link;
   no review required for internal.
5. **Production rollout**: complete the Store listing (icon, feature
   graphic 1024×500, ≥2 phone screenshots), content rating
   questionnaire, target audience, data safety form, then promote the
   internal release to production. Google reviews in ~3 days.

## Common gotchas

**Capacitor warns "Capacitor doesn't know what plugins are installed."**
Run `pnpm cap:sync` after every `pnpm install` so the native project
picks up plugin manifest changes.

**iOS build fails with "No such module 'Capacitor'."**
Run `cd ios/App && pod install` then reopen the workspace (`.xcworkspace`,
NOT `.xcodeproj`).

**Google OAuth opens in an external browser instead of the webview.**
That's the secure default for OAuth in Capacitor 6+. The OAuth callback
redirects back into the app via a deep link — make sure the
`google-services.json` (Android) / `GoogleService-Info.plist` (iOS) are
in place and the redirect URI registered in Google Cloud matches the
deep-link scheme.

**App Store rejects with "Guideline 4.2: Minimum Functionality."**
Add a native push registration on first launch and call it out in the
review notes. Reviewers want at least one thing the webview alone
can't do.

## Bundled-shell mode (advanced)

The default config points the webview at the live Vercel URL — fast
to ship, slower app-store reviews. To switch to bundled mode (native
app contains the web bundle, no live URL):

1. In `apps/web`, add a Next config that exports static HTML (drops the
   server components surface we currently lean on — significant work).
2. Build the static bundle into `apps/mobile/www/`.
3. Comment out the entire `server: {...}` block in `capacitor.config.ts`.
4. `pnpm cap:sync` to copy `www/` into the native projects.

We've optimized for the first mode; the second mode would need a
parallel SSR-free web build that's out of scope for the first launch.

## Cost summary

| | |
|---|---|
| Apple Developer Program | $99 / year |
| Google Play Console | $25 one-time |
| **Total to ship to both stores** | **$124 first year, $99 / yr after** |

Render / Vercel / Neon stay on free tier — the mobile shell adds no
recurring infrastructure cost beyond the developer accounts above.
