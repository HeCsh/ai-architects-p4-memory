// AI Architects news bot
// GitHub Actions runs this file on a timer. It:
//   1. reads the news feed named in config.json
//   2. (Class 3) asks Gemini to summarise each new article
//   3. saves everything to public/news.json, which the website reads
// No packages to install: it only uses what comes with Node.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || 'config.json';
const NEWS_PATH = process.env.NEWS_PATH || 'public/news.json';
const FEED_FILE = process.env.FEED_FILE || ''; // teacher testing only: read a saved feed instead of the internet
const GEMINI_URL = process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_SUMMARIES_PER_RUN = 12;
const PAUSE_BETWEEN_AI_CALLS_MS = Number(process.env.AI_PAUSE_MS ?? 4500); // stays under the free per-minute limit

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
let problems = 0;

// ===================================================================
// CLASS 4: MEMORY  (finished version)
// The bot checks every article against the ones already saved, so the
// same story never gets added twice.
// ===================================================================

// Two links can point at the same story and still look different, because
// feeds stick tracking tags on the end:
//     .../penguins          and     .../penguins?utm_source=rss
// Cutting off everything after ? or # makes both look the same, so the
// bot spots them as one story.
function sameStory(link) {
  try {
    const tidy = new URL(link);
    tidy.search = '';
    tidy.hash = '';
    return tidy.toString().replace(/\/$/, '');
  } catch {
    return link; // not a proper address: compare it as-is
  }
}

function alreadySaved(article, savedLinks) {
  return savedLinks.has(sameStory(article.link));
}

// ---------- 1. Read the feeds ----------

// The websites to pull from live in config.json. Add as many as you like:
//   "sources": [
//     { "name": "Space", "feedUrl": "https://www.nasa.gov/news-release/feed/" }
//   ]
// Older copies of this project had a single "feedUrl" instead. That still works.
function sourcesFromConfig() {
  if (Array.isArray(config.sources) && config.sources.length) {
    return config.sources
      .filter((s) => s && s.feedUrl)
      .map((s, i) => ({ name: s.name || `Source ${i + 1}`, feedUrl: s.feedUrl }));
  }
  if (config.feedUrl) return [{ name: config.topic || 'News', feedUrl: config.feedUrl }];
  return [];
}

async function getFeedText(feedUrl) {
  if (FEED_FILE) return readFile(FEED_FILE, 'utf8');
  const res = await fetch(feedUrl, {
    headers: { 'user-agent': 'ai-architects-news-bot' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`The feed answered with error ${res.status}. Check the address in config.json.`);
  return res.text();
}

function clean(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#8211;|&ndash;/g, '-').replace(/&#8212;|&mdash;/g, '-')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ') // tags that were hidden inside escaped HTML
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (m && clean(m[1])) return m[1];
  }
  return '';
}

function linkOf(block) {
  const rss = clean(firstTag(block, ['link']));
  if (rss) return rss;
  const atom = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1].replace(/&amp;/g, '&') : '';
}

function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => {
    const rawDate = clean(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const date = rawDate ? new Date(rawDate) : null;
    const snippet = clean(firstTag(block, ['description', 'summary', 'content:encoded', 'content']));
    return {
      title: clean(firstTag(block, ['title'])),
      link: linkOf(block),
      published: date && !isNaN(date) ? date.toISOString() : null,
      snippet: snippet.length > 400 ? snippet.slice(0, 397).replace(/\s+\S*$/, '') + '...' : snippet,
      summary: null,
    };
  }).filter((a) => a.title && a.link);
}

// ---------- 2. Ask Gemini for a summary ----------
async function summarise(article) {
  const res = await fetch(`${GEMINI_URL}/${config.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${config.summaryPrompt}\n\nTitle: ${article.title}\nText: ${article.snippet || article.title}` }] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini answered with error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
  const tidy = text.replace(/^#+\s.*$/gm, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if (!tidy) throw new Error('Gemini sent back an empty answer.');
  return tidy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 3. Put it all together ----------
async function main() {
  if (!config.newsBot) {
    try {
      const current = JSON.parse(await readFile(NEWS_PATH, 'utf8'));
      if (current.topic !== config.topic) {
        current.topic = config.topic;
        await writeFile(NEWS_PATH, JSON.stringify(current, null, 2) + '\n');
        console.log(`Topic changed to "${config.topic}".`);
      }
    } catch { /* no news.json yet */ }
    console.log('The news bot is switched off ("newsBot": false in config.json). Website will publish with the news already saved.');
    return;
  }
  let saved = { topic: config.topic, updatedAt: null, articles: [] };
  try { saved = JSON.parse(await readFile(NEWS_PATH, 'utf8')); } catch { /* first run: nothing saved yet */ }
  saved.articles = saved.articles.filter((a) => !a.sample); // sample stories from Project 1 go away
  const savedLinks = new Set(saved.articles.map((a) => sameStory(a.link)));

  const sources = sourcesFromConfig();
  if (sources.length === 0) {
    console.error('::error::No websites to pull from. Add a "sources" list to config.json.');
    console.error('Your website was NOT changed.');
    process.exit(1);
  }

  // Each website is read in turn. One broken website must not stop the others,
  // so a failure here is a warning and the bot carries on down the list.
  const fresh = [];
  const broken = [];
  for (const source of sources) {
    try {
      const items = parseFeed(await getFeedText(source.feedUrl));
      for (const item of items) item.source = source.name;
      fresh.push(...items);
      console.log(`${source.name}: ${items.length} articles.`);
    } catch (err) {
      broken.push(source.name);
      console.error(`::warning::Could not read ${source.name} (${source.feedUrl}): ${err.message}`);
    }
    if (FEED_FILE) break; // teacher testing: one saved feed stands in for the lot
  }

  if (fresh.length === 0) {
    console.error('::error::None of the websites in config.json gave us any articles.');
    console.error('Your website was NOT changed, so it still shows the last good news.');
    process.exit(1);
  }
  if (broken.length) {
    console.log(`Carried on without: ${broken.join(', ')}.`);
  }

  // Feeds sometimes list the same story twice in one go, so every story the
  // bot accepts is added to savedLinks straight away. Without that line the
  // bot would take both copies in a single run and the story would appear
  // twice on the website.
  const newOnes = [];
  for (const article of fresh) {
    if (alreadySaved(article, savedLinks)) continue;
    savedLinks.add(sameStory(article.link));
    newOnes.push(article);
  }
  console.log(`${fresh.length} articles across ${sources.length - broken.length} website(s). ${newOnes.length} counted as new.`);

  let articles = [...newOnes, ...saved.articles]
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, config.maxArticles || 12);

  if (config.aiSummaries) {
    if (!process.env.GEMINI_API_KEY) {
      console.error('::error::aiSummaries is true but the GEMINI_API_KEY secret is missing. Add it in Settings > Secrets and variables > Actions.');
      problems++;
    } else {
      const todo = articles.filter((a) => !a.summary).slice(0, MAX_SUMMARIES_PER_RUN);
      let ok = 0;
      for (const [i, a] of todo.entries()) {
        try {
          a.summary = await summarise(a);
          ok++;
          console.log(`Summarised: ${a.title}`);
        } catch (err) {
          console.error(`::warning::No summary for "${a.title}": ${err.message}`);
        }
        if (i < todo.length - 1) await sleep(PAUSE_BETWEEN_AI_CALLS_MS);
      }
      if (todo.length > 0 && ok === 0) {
        console.error('::error::Every AI summary failed. Check the API key, the model name in config.json, and the messages above.');
        problems++;
      }
    }
  }

  const out = { topic: config.topic, updatedAt: new Date().toISOString(), articles };
  await mkdir(dirname(NEWS_PATH), { recursive: true });
  await writeFile(NEWS_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Saved ${articles.length} articles to ${NEWS_PATH}.`);
  if (problems) process.exit(1); // red X in GitHub, but the site still gets the articles
}

await main();
