# 🌻 Happyness

**Only happy news and kind stories from strangers.** No 18+ content, no outrage, no doom, no depressing posts. A calm, uplifting feed for when X and Instagram leave you anxious.

## What it does

- **Good news feed:** pulls stories from positive-news outlets (Good News Network, Positive News, The Optimist Daily, Reasons to be Cheerful, Sunny Skyz) and wholesome communities (r/UpliftingNews, r/MadeMeSmile, r/HumansBeingBros, r/aww, r/wholesome).
- **Joy filter:** every story, *even from those happy sources*, is checked before you see it:
  1. **Hard block:** anything touching adult/18+ content, violence, death, self-harm, war, disasters, disease, crime or politics is dropped, however positive the rest sounds.
  2. **Joy score:** the remaining text must score as clearly positive (weighted word lists, negation handling, emoji).
- **Stories from strangers:** anyone can share a small happy moment. Posts go through the same filter, so sad or negative posts are refused (with a kind note). Readers react with 😊 ❤️ 👏, and a post that gets reported twice is hidden.
- **🛡️ Mood shield:** add your own words to hide (exams, spiders, an ex…). You can also switch to text only.
- **Gentle stop:** no endless scrolling. After a set number of stories (48 by default) the app suggests you take a break.
- **Little moments:** short calming notes appear between stories.
- **Installable app (PWA):** works on phones (Add to Home Screen) and has dark mode.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There are **no dependencies to install**.

```bash
git clone https://github.com/Dattaharshithreddy/Happyness.git
cd Happyness
npm start
```

Open http://localhost:3000. On your phone, connect to the same Wi-Fi, open `http://<your-computer-ip>:3000`, then choose **Add to Home Screen**.

```bash
npm test     # run the joy-filter tests
npm run dev  # auto-restart on changes
```

## 📱 Android app (APK)

**Download:** open the [Releases page](https://github.com/Dattaharshithreddy/Happyness/releases) on your Android phone, tap the latest `Happyness-x.y.z.apk`, allow your browser to *install unknown apps*, and tap **Install**.

The app works **on its own, with no server needed**. It downloads the good-news feeds on your phone and runs the same joy filter there. Your posts, reactions and Mood shield settings are saved on the phone. If you host your own Happyness server (see below), enter its address under **Mood shield → Community server**. Your stories are then shared with everyone who uses that server.

### How the APK is built

`.github/workflows/android.yml` builds the APK on GitHub Actions whenever `android/`, `public/` or `shared/` changes, and publishes it as a GitHub Release. You can also start it by hand from the **Actions** tab (**Build Android APK → Run workflow**).

To build it yourself, you need Android Studio or the Android SDK plus JDK 17:

```bash
cd android
./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

The Android project (`android/`) is a small native shell (`MainActivity.java`) around the same web app. The web app (`public/` and `shared/`) is copied into the APK at build time.

**Signing:** no signing key is stored in this repo. Without one, CI signs the APK with a temporary Android debug key, which changes on every build. Installing a newer build then means uninstalling the old one first, which deletes your saved posts and settings. To get smooth updates, create your own private key once:

```bash
keytool -genkeypair -keystore happyness.jks -alias happyness -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 happyness.jks   # copy the output
```

Then, in GitHub, go to **Settings → Secrets and variables → Actions** and add the secrets `ANDROID_KEYSTORE_BASE64` (the base64 output), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`happyness`) and `ANDROID_KEY_PASSWORD`. Keep `happyness.jks` safe and never commit it.

## Put it online (free options)

It's a single Node app, so any Node host works: **Render**, **Railway**, **Fly.io** or a small VPS.

- Start command: `npm start`
- The `PORT` environment variable is respected.
- Community posts are saved to `data/posts.json`. Set `DATA_DIR` to a persistent disk so posts survive redeploys.

## Project layout

```
shared/               code used by both the server and the Android app
  joy-filter.js       the joy filter (blocklist + positivity scoring)
  feed-core.js        feed sources, RSS/Atom parsing, filtering, tab building
  starter-stories.js  a few starter posts so the feed is never empty
server/
  server.js           HTTP server + JSON API (no frameworks)
  feeds.js            fetches the feeds, caches for 30 min
  store.js            community posts, reactions & reports (JSON file)
public/               the web app (HTML/CSS/JS, service worker, manifest)
  api.js              talks to the server, or runs fully on-device in the APK
android/              Android app (WebView shell + native feed downloader)
test/                 node:test tests
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/feed?tab=all\|news\|stories\|community&page=0&muted=a,b` | the filtered feed |
| POST | `/api/posts` `{text, name?, place?, mood?}` | share a happy moment |
| POST | `/api/posts/:id/react` `{reaction: smile\|heart\|clap, delta: 1\|-1}` | react |
| POST | `/api/posts/:id/report` | report a post (hidden after 2 reports) |
| POST | `/api/check` `{text}` | live "joy meter" score while typing |
| GET | `/api/status` | feed source health |

## Tuning the filter

Everything lives in `shared/joy-filter.js` (used by both the website and the Android app):

- `BLOCKED`: topics that are never shown
- `POSITIVE` / `NEGATIVE`: weighted vocabularies
- `MIN_SCORE` / `MIN_RATIO`: how strict the filter is

The filter errs on the side of caution. Hiding a happy story by mistake is better than showing a sad one.

---

*If you're having a hard time, please talk to someone you trust or a local helpline. You deserve support. 💛*
