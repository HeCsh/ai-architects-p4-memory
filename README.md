# AI Architects · Project 4: Teach it memory (checkpoint)

Finished state of Projects 1-4. Two things are working here:

- **Memory.** The bot remembers which stories it has already saved (`alreadySaved` in `scripts/update-news.mjs`), so nothing repeats.
- **Your own choice of websites.** The websites the bot reads live in `config.json`, not inside the bot. Add a link there and the bot starts pulling from it. The website grows a button for each one.

Use this repo as the catch-up checkpoint for anyone who fell behind.

**Needs a secret:** `GEMINI_API_KEY` under Settings > Secrets and variables > Actions.

## How this repo works

| File | What it does |
| --- | --- |
| `index.html` | The website. AI Studio replaces this with its own design; this plain version is the backup. |
| `public/news.json` | The news the website shows. The bot rewrites it; never edit it by hand once the bot is on. |
| `config.json` | The settings learners change: topic, the list of websites to pull from, AI on or off, the summary prompt. |
| `scripts/update-news.mjs` | The news bot. Reads the feed, asks Gemini for summaries, saves `news.json`. |
| `.github/workflows/update-site.yml` | The timer. GitHub Actions runs the bot, then publishes the site to GitHub Pages. |
| `scripts/add-source.mjs` | Answers the Add a news website box. Finds the feed, checks it, writes it into `config.json`. |
| `.github/workflows/add-source.yml` | Runs that script whenever someone uses the box. |

## One-time setup for a new copy

1. Keep the repository **Public** (free Actions and Pages need it).
2. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. Actions tab > "Update and publish site" > **Run workflow**. Wait for the green tick.
4. The site address appears on the run page and in Settings > Pages.

## Choose which websites to pull from

**The easy way, from your own site.** Press **Add a news website** next to the filter buttons, paste the ordinary address of a news site, and press **Add it**. A page opens asking you to confirm; press the green button on it. Within a few minutes the website appears on your site as a new filter button.

You do not need the feed address. Paste `www.nasa.gov` and the robot finds the feed behind it, checks it works, and names the button from the feed itself. If a site has no feed, it says so and nothing changes.

Only the owner of a copy can add websites to it. A visitor pressing the button cannot change your site.

**The other way, by hand.** Open `config.json`. The `sources` list is the control panel. Every website in it gets read on every run.

```json
"sources": [
  { "name": "Science", "feedUrl": "https://www.snexplores.org/feed" },
  { "name": "Space",   "feedUrl": "https://www.nasa.gov/news-release/feed/" }
]
```

To add a website, add one more line to the list. `name` is the label that appears on the button. Save the file and the bot picks it up on its next run, or press **Run workflow** on the Actions tab to see it straight away.

Two things worth knowing:

- Buttons for choosing a website only appear once there are two or more in the list. With one, there is nothing to choose between.
- If one website is down or the address is wrong, the bot writes a warning, skips it, and carries on with the rest. It does not stop.

### Addresses that work (checked 31 Oct 2026)

These are feed addresses, which are not the same as the address you see in your browser. Pick from this list rather than pasting a website address.

| Topic | feedUrl |
| --- | --- |
| Science (written for ages 10-14) | https://www.snexplores.org/feed |
| Space | https://www.nasa.gov/news-release/feed/ |
| Tech and startups (teacher check for suitability) | https://techcrunch.com/feed/ |

Older copies of this project had a single `feedUrl` setting instead of a `sources` list. Those still work, so nothing breaks for a learner who has not updated yet.

Part of the JetLearn **AI Architects** course, Projects 1-4.

