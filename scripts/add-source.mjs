// Adds a news website to config.json.
//
// A learner pastes a web address into the box on their own site. That opens a
// request, and this file is what answers it. It:
//   1. works out the feed address, even if they pasted the ordinary one
//   2. checks the feed really works
//   3. gives it a name taken from the feed itself
//   4. writes it into config.json, so the news bot starts reading it
//
// Run by hand for testing:  node scripts/add-source.mjs "https://www.nasa.gov/"

import { readFile, writeFile } from 'node:fs/promises';

const CONFIG_PATH = process.env.CONFIG_PATH || 'config.json';

// Things that are not a web address at all, or that we should not fetch.
function tidyAddress(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('No web address was given.');
  if (text.length > 500) throw new Error('That address is too long to be real.');
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${raw}" is not a web address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only ordinary web addresses work here.');
  }
  // Keep this off private networks: a learner's site must not be able to make
  // the robot knock on doors inside GitHub.
  const host = url.hostname.toLowerCase();
  const blocked = host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host)
    || host === '[::1]';
  if (blocked) throw new Error('That address is not a public website.');
  return url.toString();
}

async function get(address) {
  const res = await fetch(address, {
    headers: { 'user-agent': 'ai-architects-news-bot' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`answered with error ${res.status}`);
  return res.text();
}

function looksLikeAFeed(text) {
  return /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text) || /<channel[\s>]/i.test(text);
}

function countStories(text) {
  const items = text.match(/<item[\s>]/gi) || text.match(/<entry[\s>]/gi) || [];
  return items.length;
}

// The name on the button. Taken from the feed's own title where there is one,
// so the learner does not have to invent it.
function nameFromFeed(text, address) {
  const m = text.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  let name = m ? m[1] : '';
  name = name
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // Feed titles can be long, and often carry the site name after a dash or a
  // bar. Keep the first part, which is the bit worth putting on a button.
  name = name.split(/\s+(?:[|–—]|-{1,2}|·)\s+/)[0].trim();
  if (name.length > 28) name = name.slice(0, 27).replace(/\s+\S*$/, '') + '.';
  if (!name) {
    try { name = new URL(address).hostname.replace(/^www\./, ''); } catch { name = 'News'; }
  }
  return name;
}

// A learner will usually paste the address they see in their browser, which is
// the website and not its feed. These are the usual places a feed hides.
function guesses(address) {
  const url = new URL(address);
  const root = `${url.protocol}//${url.host}`;
  return [
    address,
    `${root}/feed`,
    `${root}/rss`,
    `${root}/feed.xml`,
    `${root}/rss.xml`,
    `${root}/index.xml`,
    `${root}/atom.xml`,
  ];
}

// Some sites say where their feed is, inside the page itself.
function feedLinkInPage(html, address) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) {
      try { return new URL(href[1].replace(/&amp;/g, '&'), address).toString(); } catch { /* skip */ }
    }
  }
  return null;
}

export async function findFeed(rawAddress) {
  const address = tidyAddress(rawAddress);
  const tried = [];

  for (const candidate of guesses(address)) {
    try {
      const text = await get(candidate);
      if (looksLikeAFeed(text)) {
        const stories = countStories(text);
        if (stories === 0) throw new Error('the feed is empty');
        return { feedUrl: candidate, name: nameFromFeed(text, candidate), stories };
      }
      // Not a feed. If it is the page itself, it may say where its feed is.
      if (candidate === address) {
        const pointed = feedLinkInPage(text, address);
        if (pointed) {
          const feedText = await get(pointed);
          if (looksLikeAFeed(feedText)) {
            const stories = countStories(feedText);
            if (stories === 0) throw new Error('the feed is empty');
            return { feedUrl: pointed, name: nameFromFeed(feedText, pointed), stories };
          }
        }
      }
      tried.push(candidate);
    } catch (err) {
      tried.push(`${candidate} (${err.message})`);
    }
  }

  throw new Error(
    `No news feed was found at that address.\n\nTried:\n- ${tried.join('\n- ')}\n\n` +
    'Not every website publishes a feed. Try one from the list in the README.'
  );
}

export function addToConfig(config, found) {
  // Older copies kept one feedUrl. Turn that into the list before adding.
  let sources = Array.isArray(config.sources) ? [...config.sources] : [];
  if (!sources.length && config.feedUrl) {
    sources = [{ name: config.topic || 'News', feedUrl: config.feedUrl }];
  }

  const already = sources.find((s) => s.feedUrl === found.feedUrl);
  if (already) throw new Error(`That website is already on the list, as "${already.name}".`);
  if (sources.length >= 8) throw new Error('There are already 8 websites. Remove one before adding another.');

  // Two websites must not share a button name.
  let name = found.name;
  if (sources.some((s) => s.name === name)) {
    let n = 2;
    while (sources.some((s) => s.name === `${name} ${n}`)) n++;
    name = `${name} ${n}`;
  }

  sources.push({ name, feedUrl: found.feedUrl });
  const next = { ...config, sources };
  delete next.feedUrl; // the list replaces it
  return { config: next, name };
}

// Running the file directly, rather than importing it, does the whole job.
// Anything that goes wrong is written as a plain sentence, because a learner
// reads it on their own request rather than in a log.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { appendFile } = await import('node:fs/promises');
  const report = async (key, value) => {
    if (!process.env.GITHUB_OUTPUT) return;
    const token = `EOF_${Math.random().toString(36).slice(2)}`;
    await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${token}\n${value}\n${token}\n`);
  };

  try {
    const found = await findFeed(process.argv[2] || process.env.SOURCE_URL);
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    const { config: next, name } = addToConfig(config, found);
    await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
    const line = `Added "${name}" (${found.feedUrl}), ${found.stories} stories.`;
    console.log(line);
    await report('result', 'added');
    await report('message', `Added **${name}**.\n\nFeed: ${found.feedUrl}\nStories found: ${found.stories}\n\nYour site updates on its next run, or press Run workflow on the Actions tab to see it now.`);
  } catch (err) {
    console.error(err.message);
    await report('result', 'failed');
    await report('message', err.message);
    process.exit(1);
  }
}
