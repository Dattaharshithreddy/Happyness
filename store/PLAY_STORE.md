# Publishing Happyness on Google Play

This is the checklist from "code in GitHub" to "anyone can install it". The steps marked **you** need your own accounts; everything else is already done in this repo.

## 1. Put the community server online (you, ~15 minutes)

Strangers' stories are shared through your server, so it must be online before the app goes public.

**Option A, Render (easiest):** go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint** → choose this repository. `render.yaml` sets everything up, including a 1 GB disk so posts survive restarts. The disk needs the Starter plan (about US$7/month).

**Option B, anywhere that runs Docker** (Railway, Fly.io, a VPS): build the `Dockerfile` and mount a persistent volume at `/data`.

Set these environment variables on the server:

| Variable | Value |
|---|---|
| `ADMIN_TOKEN` | A long random password (16+ characters). Render generates one; find it under **Environment**. |
| `CONTACT_EMAIL` | The support email shown on the privacy and terms pages |
| `STORE_SAFE` | `1`: headlines and links only, no Reddit (see "Content rights" below) |
| `ANTHROPIC_API_KEY` | *Optional but recommended.* Turns on the AI kindness check. Get a key at [console.anthropic.com](https://console.anthropic.com). |
| `MODERATION_MODEL` | *Optional.* Defaults to `claude-opus-5-5`. Set `claude-haiku-5-5` for a much cheaper check. |
| `MODERATION_FALLBACK` | *Optional.* `keywords` (default) or `review` (hold every post for you if the AI is down) |

Check that it works:
- `https://YOUR-SERVER/api/health` shows `{"ok":true}`
- `https://YOUR-SERVER/privacy`, `/terms` and `/delete-account` open
- `https://YOUR-SERVER/admin`: enter your `ADMIN_TOKEN` to see the moderation queue. **Check it daily.** Google expects reports to be handled promptly.

## 2. Build the store version of the app (you, 2 minutes)

In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add:

| Variable | Value |
|---|---|
| `HAPPYNESS_SERVER_URL` | `https://YOUR-SERVER` (no trailing slash) |
| `HAPPYNESS_STORE_SAFE` | `1` |
| `HAPPYNESS_CONTACT_EMAIL` | Your support email |

Then go to **Actions → Build Android APK → Run workflow**. The release it creates has two files:
- **`.aab`**: upload this to Google Play.
- **`.apk`**: install this on your own phone to test.

The signing key you already added as secrets becomes your Play **upload key**. Keep `happyness.jks` and its password backed up.

## 3. Google Play Console (you)

1. **Create a developer account** at [play.google.com/console](https://play.google.com/console). It costs US$25 once and needs identity verification.
2. **Create app** → name `Happyness`, App, Free.
3. **Closed testing first (required for new personal accounts):** go to **Testing → Closed testing**, create a track, upload the `.aab`, and add **at least 12 testers** (their Google account emails). They must stay opted in for **14 days** before you can apply for production. Friends and family are fine.
4. Fill in **App content** (Policy → App content) using the answers below.
5. Fill in **Main store listing** using the text and graphics below.
6. After 14 days, go to **Production → Create release**, upload the newest `.aab`, and submit for review.

## 4. Store listing

**App name** (30 max): `Happyness: Only Happy News`

**Short description** (80 max):
> Only kind, happy stories. No outrage, no doom, no 18+. A calm feed that cheers you up.

**Full description:**
> Tired of feeds that leave you anxious? Happyness shows only good news and kind stories from strangers around the world.
>
> 🌻 GOOD NEWS ONLY
> Headlines from positive-news publishers, checked by our joy filter. Violence, disasters, politics, adult content and sad stories are filtered out before you ever see them.
>
> 💛 KIND STORIES FROM STRANGERS
> Share a small happy moment, like a kind stranger, a proud day or a silly pet, and smile at other people's. Every story is checked before it appears.
>
> 🛡️ YOUR MOOD SHIELD
> Hide any topic you don't want to see. Report or block anyone in two taps.
>
> 🌿 NO ENDLESS SCROLLING
> A gentle stop after a set number of stories reminds you to take a break, and little calming notes appear along the way.
>
> 🔒 PRIVATE BY DESIGN
> No email or phone number needed. No ads. No tracking. Delete your account and everything you posted anytime.
>
> Happyness is a feel-good reading app, not a medical or support service. If you're having a hard time, please reach out to someone you trust or a local helpline.

**Category:** News & Magazines (or Lifestyle). **Tags:** positive, news, wholesome.

**Graphics** (in `store/graphics/`):
- App icon: `icon-512.png`
- Feature graphic: `feature-graphic-1024x500.png`
- Phone screenshots: `screenshot-1-feed.png` … `screenshot-4-mood-shield.png`

## 5. App content answers

| Section | Answer |
|---|---|
| Privacy policy | `https://YOUR-SERVER/privacy` |
| Ads | No ads |
| App access | All functionality is available without special access (no login) |
| Content rating | Complete the IARC questionnaire honestly: **users can interact and share content: Yes** (moderated, with reporting and blocking); no violence, sex, drugs or gambling. Expect roughly Teen / PEGI 12. |
| Target audience | 13+ (do **not** select under-13 age groups) |
| News apps | Happyness shows news headlines from publishers. If asked, Google may treat it as a news app. Answer honestly and link to the sources (they're listed in `shared/feed-core.js`). |
| Health apps | No (don't describe it as treating depression or anxiety) |
| Government apps / Financial features | No |
| Account deletion | Yes. Users can delete in-app (Mood shield → Your account). Web link: `https://YOUR-SERVER/delete-account` |

### Data safety form

| Question | Answer |
|---|---|
| Does your app collect or share user data? | Yes |
| Is all data encrypted in transit? | Yes |
| Can users request deletion? | Yes |

Data types to declare (**collected**, **not shared**; processing by service providers such as hosting and AI moderation doesn't count as "sharing"):

| Data type | Required? | Purposes |
|---|---|---|
| Personal info → **Name** (display name) | Optional | App functionality |
| Personal info → **User IDs** (random account ID) | Required to post/react | App functionality, Fraud prevention/security |
| Messages → **Other in-app messages** *or* App activity → **Other user-generated content** (stories) | Optional | App functionality |
| App activity → **App interactions** (reactions, reports, blocks) | Optional | App functionality, Fraud prevention/security |
| Location → **Approximate location** (the city users can type) | Optional | App functionality |

Not collected: email, phone, contacts, precise location, photos, health, financial info, device IDs, crash logs, analytics.

## 6. Content rights (read before launch)

- **Store-safe mode (`STORE_SAFE=1` / `HAPPYNESS_STORE_SAFE=1`)** shows only headlines, the publisher's name and a link. It doesn't copy article summaries or images, and it leaves out Reddit, whose API terms don't allow this use in a public app without Reddit's approval.
- Even headline aggregation can raise questions with some publishers. If one asks, remove it from `SOURCES` in `shared/feed-core.js`. Partnering with publishers or using a licensed news API is the more robust long-term route.
- **Not legal advice:** the privacy policy and terms in `public/` are a solid starting point that matches how the app actually works, but have them reviewed if you can, especially if you'll have users in the EU or California.

## 7. After launch

- **Moderate daily** at `/admin`. Approve or remove held posts, and ban people who break the rules.
- **Back up** the server's `/data/happyness.db` regularly. Render disks support snapshots.
- **Every update:** push your changes, run the workflow, and upload the new `.aab` to Play. The version number increases automatically.
- **Google raises the required Android version yearly.** When Play Console warns you, bump `compileSdk`/`targetSdk` in `android/app/build.gradle`.
