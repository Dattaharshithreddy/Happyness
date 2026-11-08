# 🌻 Happyness

**Only happy news and kind stories from strangers.** No 18+ content, no outrage, no doom, no depressing posts. A calm, uplifting feed for when X and Instagram leave you anxious.

## What it does

- **Good news feed:** pulls stories from positive-news outlets (Good News Network, Positive News, The Optimist Daily, Reasons to be Cheerful, Sunny Skyz) and wholesome communities (r/UpliftingNews, r/MadeMeSmile, r/HumansBeingBros, r/aww, r/wholesome).
- **Joy filter:** every story, *even from those happy sources*, is checked before you see it:
  1. **Hard block:** anything touching adult/18+ content, violence, death, self-harm, war, disasters, disease, crime or politics is dropped, however positive the rest sounds.
  2. **Joy score:** the remaining text must score as clearly positive (weighted word lists, negation handling, emoji).
- **Stories from strangers:** anyone can share a small happy moment. Accounts are anonymous: no email or phone, just a private key on the device. Every post is checked before it appears (see Moderation). Readers react with 😊 ❤️ 👏, can report a story or block its author, and a story reported by 3 people is hidden until a moderator reviews it.
- **Your data, your call:** delete any story you wrote, or your whole account, from the Mood shield.
- **🛡️ Mood shield:** add your own words to hide (exams, spiders, an ex…). You can also switch to text only.
- **Gentle stop:** no endless scrolling. After a set number of stories (48 by default) the app suggests you take a break.
- **Little moments:** short calming notes appear between stories.
- **Installable app (PWA):** works on phones (Add to Home Screen) and has dark mode.

## Run it

You need [Node.js](https://nodejs.org) **22.5 or newer** (it uses Node's built-in SQLite).

```bash
git clone https://github.com/Dattaharshithreddy/Happyness.git
cd Happyness
npm install      # only the Anthropic SDK, used for optional AI moderation
npm start
```

Open http://localhost:3000. On your phone, connect to the same Wi-Fi, open `http://<your-computer-ip>:3000`, then choose **Add to Home Screen**.

```bash
npm test     # run the joy-filter tests
npm run dev  # auto-restart on changes
```

## 📱 Android app (APK)

**Download:** open the [Releases page](https://github.com/Dattaharshithreddy/Happyness/releases) on your Android phone, tap the latest `Happyness-x.y.z.apk`, allow your browser to *install unknown apps*, and tap **Install**.

Without a server, the app works **on its own**: it downloads the good-news feeds on your phone and runs the same joy filter there, and your posts stay on the phone. With a server, built in through the `HAPPYNESS_SERVER_URL` repository variable or typed under **Mood shield → Community server**, stories are shared with everyone using that server.

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

## Moderation

1. **Keyword filter:** anything on the blocklist is rejected instantly.
2. **AI kindness check (optional):** set `ANTHROPIC_API_KEY` and Claude reviews each new story, then approves it, rejects it, or holds it for a human. `MODERATION_MODEL` picks the model (default `claude-opus-5-5`; `claude-haiku-5-5` is much cheaper). If the AI is unreachable, `MODERATION_FALLBACK=keywords` (default) trusts the keyword filter, and `review` holds every post for you instead.
3. **People:** readers report and block, and moderators use **`/admin`** (protected by `ADMIN_TOKEN`) to approve, remove or ban.

## Server settings

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Where `happyness.db` lives. Use a persistent disk in production |
| `ADMIN_TOKEN` | Password for `/admin` (16+ characters; admin is off when unset) |
| `CONTACT_EMAIL` | Shown on `/privacy`, `/terms` and `/delete-account` |
| `STORE_SAFE` | `1` = headlines + links only, no Reddit (Play Store mode) |
| `ANTHROPIC_API_KEY`, `MODERATION_MODEL`, `MODERATION_FALLBACK` | AI moderation (see above) |
| `TRUST_PROXY` | `1` when behind a reverse proxy, so rate limits use the real client IP |
| `REPORTS_TO_HIDE` | Reports needed to hide a story (default 3) |

## Publishing on Google Play

See **[store/PLAY_STORE.md](store/PLAY_STORE.md)**: deploying the server, building the store version, the Play Console steps, listing text, Data safety answers and graphics.

## Put it online

Use the `Dockerfile` (any Docker host) or `render.yaml` (Render blueprint). Mount a persistent disk at `/data` so posts survive restarts. Details are in [store/PLAY_STORE.md](store/PLAY_STORE.md).

## Project layout

```
shared/               code used by both the server and the Android app
  joy-filter.js       the joy filter (blocklist + positivity scoring)
  feed-core.js        feed sources, RSS/Atom parsing, filtering, tab building
  starter-stories.js  a few starter posts so the feed is never empty
server/
  server.js           HTTP server + JSON API (no frameworks)
  db.js               SQLite: accounts, posts, reactions, reports, blocks
  moderation.js       keyword + optional Claude moderation
  feeds.js            fetches the feeds, caches for 30 min
public/               the web app (HTML/CSS/JS, service worker, manifest)
  admin.html          moderation queue (/admin)
  privacy.html, terms.html, delete-account.html
  api.js              talks to the server, or runs fully on-device in the APK
android/              Android app (WebView shell + native feed downloader)
store/                Play Store guide, listing graphics and screenshots
test/                 node:test tests
```

### API

Authenticated calls send `Authorization: Bearer <token>` (the token comes from `POST /api/account`).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/account` `{name?}` | create an anonymous account → `{token, user}` |
| GET / PATCH / DELETE | `/api/account` | your profile, stories and blocks / rename / delete everything |
| GET | `/api/feed?tab=all\|news\|stories\|community&page=0&muted=a,b` | the filtered feed |
| POST | `/api/posts` `{text, place?, mood?, agree: true}` | share a happy moment (moderated) |
| DELETE | `/api/posts/:id` | delete your own story |
| POST | `/api/posts/:id/react` `{reaction: smile\|heart\|clap, on: true\|false}` | react |
| POST | `/api/posts/:id/report` `{reason}` | report (hidden after 3 reports) |
| POST / DELETE | `/api/users/:id/block` | block / unblock a person |
| POST | `/api/check` `{text}` | live "joy meter" score while typing |
| GET | `/api/status`, `/api/health` | feed source health / uptime check |
| GET, POST | `/api/admin/...` (header `X-Admin-Token`) | moderation queue, approve/remove, ban |

## Tuning the filter

Everything lives in `shared/joy-filter.js` (used by both the website and the Android app):

- `BLOCKED`: topics that are never shown
- `POSITIVE` / `NEGATIVE`: weighted vocabularies
- `MIN_SCORE` / `MIN_RATIO`: how strict the filter is

The filter errs on the side of caution. Hiding a happy story by mistake is better than showing a sad one.

---

*If you're having a hard time, please talk to someone you trust or a local helpline. You deserve support. 💛*
