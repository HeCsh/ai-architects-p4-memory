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
// CLASS 4: MEMORY
// Right now the bot has no memory. It thinks every article is new,
// every single time it runs, so the same stories pile up.
// Your fix: change   return false;
//           to       return savedLinks.has(article.link);
// ===================================================================
function alreadySaved(article, savedLinks) {
  return false;
}

// ---------- 1. Read the feed ----------
async function getFeedText() {
  if (FEED_FILE) return readFile(FEED_FILE, 'utf8');
  const res = await fetch(config.feedUrl, {
    headers: { 'user-agent': 'ai-architects-news-bot' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`The feed answered with error ${res.status}. Check feedUrl in config.json.`);
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
  const savedLinks = new Set(saved.articles.map((a) => a.link));

  let fresh;
  try {
    fresh = parseFeed(await getFeedText());
  } catch (err) {
    console.error(`::error::Could not read the feed: ${err.message}`);
    console.error('Your website was NOT changed, so it still shows the last good news.');
    process.exit(1);
  }
  if (fresh.length === 0) {
    console.error('::error::The feed had no articles in it. Is feedUrl really an RSS or Atom feed?');
    console.error('Your website was NOT changed.');
    process.exit(1);
  }

  const newOnes = fresh.filter((a) => !alreadySaved(a, savedLinks));
  console.log(`Feed has ${fresh.length} articles. ${newOnes.length} counted as new.`);

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
