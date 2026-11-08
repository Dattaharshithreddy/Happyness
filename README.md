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

## Put it online (free options)

It's a single Node app, so any Node host works: **Render**, **Railway**, **Fly.io** or a small VPS.

- Start command: `npm start`
- The `PORT` environment variable is respected.
- Community posts are saved to `data/posts.json`. Set `DATA_DIR` to a persistent disk so posts survive redeploys.

## Project layout

```
server/
  server.js           HTTP server + JSON API (no frameworks)
  filter.js           the joy filter (blocklist + positivity scoring)
  feeds.js            fetches RSS/Atom feeds, filters them, caches for 30 min
  store.js            community posts, reactions & reports (JSON file)
  starter-stories.js  a few starter posts so the feed is never empty
public/               the app (HTML/CSS/JS, service worker, manifest)
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

Everything lives in `server/filter.js`:

- `BLOCKED`: topics that are never shown
- `POSITIVE` / `NEGATIVE`: weighted vocabularies
- `MIN_SCORE` / `MIN_RATIO`: how strict the filter is

The filter errs on the side of caution. Hiding a happy story by mistake is better than showing a sad one.

---

*If you're having a hard time, please talk to someone you trust or a local helpline. You deserve support. 💛*
