// The helper that lets the Add a news website box work without leaving the site.
//
// WHY THIS EXISTS
// A website made of files cannot change itself. To add a news website, something
// has to edit config.json in the project, and editing the project needs a
// password. A password cannot live in the page, because everything the page
// knows, every visitor knows.
//
// So the password lives here instead, on a small helper that runs on a server.
// The page asks the helper to do the job. The helper holds the password, checks
// the request is reasonable, and does the edit. The page never sees it.
//
// This is the same shape as almost every app with a login: a part people can
// see, and a part that keeps the secrets.
//
// DEPLOYING THIS
// See worker/README.md. It takes about fifteen minutes and costs nothing.

const ALLOWED_OWNER = 'HeCsh';           // only repos belonging to this account
const ALLOWED_REPO = /^ai-architects-/;  // only repos whose name starts like this
const MAX_SOURCES = 8;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Send a POST request.' }, 405, cors);

    try {
      const { owner, repo, address } = await request.json();

      // Only ever touch the course's own repositories. Without this the helper
      // would edit any project its password can reach.
      if (owner !== ALLOWED_OWNER || !ALLOWED_REPO.test(String(repo || ''))) {
        return json({ error: 'That project is not one this helper looks after.' }, 403, cors);
      }

      const found = await findFeed(address);
      const result = await addToRepo(env.GITHUB_TOKEN, owner, repo, found);
      return json(result, 200, cors);
    } catch (err) {
      return json({ error: err.message || 'Something went wrong.' }, 400, cors);
    }
  },
};

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });


// ---------- finding the feed ----------
// A learner pastes the address they see in their browser, which is the website
// and not its feed. These are the usual places a feed hides.

function tidyAddress(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('No web address was given.');
  if (text.length > 500) throw new Error('That address is too long to be real.');
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

  let url;
  try { url = new URL(text); } catch { throw new Error(`"${raw}" is not a web address.`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only ordinary web addresses work here.');
  }
  const host = url.hostname.toLowerCase();
  const blocked = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]';
  if (blocked) throw new Error('That address is not a public website.');
  return url.toString();
}

async function get(address) {
  const res = await fetch(address, {
    headers: { 'user-agent': 'ai-architects-news-bot' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`answered with error ${res.status}`);
  return res.text();
}

const looksLikeAFeed = (t) => /<rss[\s>]/i.test(t) || /<feed[\s>]/i.test(t) || /<channel[\s>]/i.test(t);
const countStories = (t) => (t.match(/<item[\s>]/gi) || t.match(/<entry[\s>]/gi) || []).length;

function nameFromFeed(text, address) {
  const m = text.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  let name = (m ? m[1] : '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
  name = name.split(/\s+(?:[|–—]|-{1,2}|·)\s+/)[0].trim();
  if (name.length > 28) name = name.slice(0, 27).replace(/\s+\S*$/, '') + '.';
  if (!name) {
    try { name = new URL(address).hostname.replace(/^www\./, ''); } catch { name = 'News'; }
  }
  return name;
}

function guesses(address) {
  const url = new URL(address);
  const root = `${url.protocol}//${url.host}`;
  return [address, `${root}/feed`, `${root}/rss`, `${root}/feed.xml`,
          `${root}/rss.xml`, `${root}/index.xml`, `${root}/atom.xml`];
}

function feedLinkInPage(html, address) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) {
      try { return new URL(href[1].replace(/&amp;/g, '&'), address).toString(); } catch { /* skip */ }
    }
  }
  return null;
}

async function findFeed(rawAddress) {
  const address = tidyAddress(rawAddress);
  for (const candidate of guesses(address)) {
    try {
      const text = await get(candidate);
      if (looksLikeAFeed(text)) {
        const stories = countStories(text);
        if (stories === 0) continue;
        return { feedUrl: candidate, name: nameFromFeed(text, candidate), stories };
      }
      if (candidate === address) {
        const pointed = feedLinkInPage(text, address);
        if (pointed) {
          const feedText = await get(pointed);
          if (looksLikeAFeed(feedText) && countStories(feedText) > 0) {
            return { feedUrl: pointed, name: nameFromFeed(feedText, pointed), stories: countStories(feedText) };
          }
        }
      }
    } catch { /* try the next one */ }
  }
  throw new Error('No news feed was found there. Not every website publishes one.');
}


// ---------- doing the edit ----------

async function gh(token, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'ai-architects-add-source',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub said no (${res.status}).`);
  return res.json();
}

async function addToRepo(token, owner, repo, found) {
  if (!token) throw new Error('This helper has not been given a password yet.');

  const file = await gh(token, `/repos/${owner}/${repo}/contents/config.json`);
  const config = JSON.parse(atob(file.content.replace(/\n/g, '')));

  let sources = Array.isArray(config.sources) ? [...config.sources] : [];
  if (!sources.length && config.feedUrl) {
    sources = [{ name: config.topic || 'News', feedUrl: config.feedUrl }];
  }

  const already = sources.find((s) => s.feedUrl === found.feedUrl);
  if (already) throw new Error(`That website is already on the list, as "${already.name}".`);
  if (sources.length >= MAX_SOURCES) {
    throw new Error(`There are already ${MAX_SOURCES} websites. Remove one before adding another.`);
  }

  let name = found.name;
  if (sources.some((s) => s.name === name)) {
    let n = 2;
    while (sources.some((s) => s.name === `${name} ${n}`)) n++;
    name = `${name} ${n}`;
  }

  sources.push({ name, feedUrl: found.feedUrl });
  const next = { ...config, sources };
  delete next.feedUrl;

  const body = JSON.stringify(next, null, 2) + '\n';
  // btoa only handles single byte characters, so encode first.
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(body)));

  await gh(token, `/repos/${owner}/${repo}/contents/config.json`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add news website: ${name}`,
      content: encoded,
      sha: file.sha,
      committer: { name: 'news-bot', email: '41898282+github-actions[bot]@users.noreply.github.com' },
    }),
  });

  return { ok: true, name, feedUrl: found.feedUrl, stories: found.stories };
}
