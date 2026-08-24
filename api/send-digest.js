// api/send-digest.js
//
// Builds and sends the weekly "Cosmic Newsseller" digest to every confirmed
// subscriber, via Buttondown (https://buttondown.com). Triggered
// automatically once a week by Vercel Cron (see "crons" in vercel.json) --
// nobody has to click a button for it to go out.
//
// What it needs to work:
//   - BUTTONDOWN_API_KEY  (free account -- see README.md)
//   - CRON_SECRET          (protects this endpoint from being triggered by
//                           anyone but Vercel's own scheduler, or you
//                           manually while testing)
// Optional:
//   - NASA_API_KEY  (powers the satellite/near-Earth-object/picture-of-the-
//                    day data -- works with a shared DEMO_KEY if unset,
//                    just at a lower rate limit)
//   - SITE_URL       (defaults to the production URL below)
//
// Note: on Buttondown's free plan, this email is rendered inside their own
// built-in theme (not a fully custom design) -- that's the trade-off for
// being able to send to anyone without owning a domain. See README.md.

const DEFAULT_SITE_URL = 'https://cosmic-newsseller.vercel.app';
const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

async function safeFetchJson(url, ms = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- same live space-data feeds Mission Control uses ----

async function getSatellites() {
  const data = await safeFetchJson('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json', 15000);
  if (!Array.isArray(data) || data.length === 0) return null;
  return { count: data.length };
}

async function getNeo() {
  const data = await safeFetchJson(`https://api.nasa.gov/neo/rest/v1/feed/today?detailed=false&api_key=${encodeURIComponent(NASA_API_KEY)}`);
  if (!data || !data.near_earth_objects) return null;
  return { count: Object.values(data.near_earth_objects).flat().length };
}

async function getApod() {
  const data = await safeFetchJson(`https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(NASA_API_KEY)}`);
  if (!data || data.media_type !== 'image' || !data.url) return null;
  return {
    title: data.title || 'NASA Astronomy Picture of the Day',
    imageUrl: data.url,
    permalink: `https://apod.nasa.gov/apod/ap${String(data.date || '').replace(/-/g, '').slice(2)}.html`,
    explanation: String(data.explanation || '').slice(0, 260),
    credit: data.copyright ? String(data.copyright).trim() : 'NASA',
  };
}

async function getLaunches() {
  const data = await safeFetchJson('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?lsp__name=SpaceX&limit=3&ordering=net');
  const results = (data && Array.isArray(data.results)) ? data.results : [];
  return results.map((l) => ({
    name: l.name || 'Unnamed launch',
    net: l.net || null,
    pad: (l.pad && l.pad.location && l.pad.location.name) || '',
  }));
}

async function getNews() {
  const data = await safeFetchJson('https://api.spaceflightnewsapi.net/v4/articles/?limit=6&ordering=-published_at');
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.map((a) => ({ title: a.title, url: a.url, site: a.news_site || 'Space news' }));
}

function fmtLaunchDate(iso) {
  if (!iso) return 'Date TBD';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
    });
  } catch (e) {
    return 'Date TBD';
  }
}

// ---- build the digest as Markdown -- Buttondown's own theme renders this
// consistently, which is more reliable than fighting their template with
// raw custom HTML on the free plan. ----

function buildDigestMarkdown(data, issueDate, siteUrl) {
  const lines = [];
  lines.push(`# 🛰️ Cosmic Newsseller — Space Digest for ${issueDate}`);
  lines.push('');
  lines.push("Hey, it's Cosmic Bear 🐻🚀 — here's what happened in orbit this week, straight from the same live feeds that power the site.");
  lines.push('');

  if (data.apod) {
    lines.push(`## Picture of the day: ${data.apod.title}`);
    lines.push('');
    lines.push(`![${data.apod.title}](${data.apod.imageUrl})`);
    lines.push('');
    lines.push(data.apod.explanation + (data.apod.explanation.length >= 260 ? '…' : ''));
    lines.push('');
    lines.push(`*Image credit: ${data.apod.credit} · NASA APOD · [See full picture](${data.apod.permalink})*`);
    lines.push('');
  }

  lines.push('## Snapshot');
  lines.push('');
  lines.push(`- **Active satellites:** ${data.satellites ? data.satellites.count.toLocaleString('en-US') : 'unavailable right now'}`);
  lines.push(`- **Near-Earth objects tracked today:** ${data.neo ? data.neo.count : 'unavailable right now'}`);
  lines.push('');

  lines.push('## Upcoming launches');
  lines.push('');
  if (data.launches.length) {
    data.launches.forEach((l) => {
      lines.push(`- **${l.name}** — ${fmtLaunchDate(l.net)}${l.pad ? ` · ${l.pad}` : ''}`);
    });
  } else {
    lines.push('No upcoming launches on file right now.');
  }
  lines.push('');

  lines.push('## Space news this week');
  lines.push('');
  if (data.news.length) {
    data.news.forEach((n) => {
      lines.push(`- [${n.title}](${n.url}) — *${n.site}*`);
    });
  } else {
    lines.push("No fresh headlines came through this time -- check the site for the latest.");
  }
  lines.push('');

  lines.push(`[Visit Cosmic Newsseller](${siteUrl})`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('You can unsubscribe any time: {{ unsubscribe_url }}');

  return lines.join('\n');
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  // --- auth: only Vercel's own scheduler (which sends this header
  // automatically) or someone who knows CRON_SECRET may trigger a real
  // send. A `?secret=...` query param is also accepted so you can trigger
  // a manual test run by just visiting a URL in a browser.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers && req.headers.authorization;
  const querySecret = req.query && req.query.secret;
  const authorized = !!cronSecret && (
    authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret
  );
  if (!authorized) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!process.env.BUTTONDOWN_API_KEY) {
    res.status(500).json({ error: 'server_misconfigured', detail: 'BUTTONDOWN_API_KEY is not set' });
    return;
  }

  const [satellites, neo, apod, launches, news] = await Promise.all([
    getSatellites(), getNeo(), getApod(), getLaunches(), getNews(),
  ]);
  const data = { satellites, neo, apod, launches, news };

  const siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL;
  const issueDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const subject = `Cosmic Newsseller — Space Digest for ${issueDate}`;
  const markdown = buildDigestMarkdown(data, issueDate, siteUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    // No "filters" field -- that means this goes out to the whole
    // (confirmed) subscriber list, which is exactly what we want for the
    // regular weekly send.
    const upstream = await fetch('https://api.buttondown.com/v1/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Token ${process.env.BUTTONDOWN_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject,
        body: markdown,
        status: 'sent',
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('[cosmic-bear-debug] buttondown send-digest failed: status=', upstream.status, 'body=', errText.slice(0, 500));
      res.status(502).json({ ok: false, error: 'send_failed', detail: errText.slice(0, 500) });
      return;
    }

    const result = await upstream.json().catch(() => null);
    res.status(200).json({ ok: true, buttondownEmailId: result && result.id, subject });
  } catch (err) {
    console.error('[cosmic-bear-debug] buttondown send-digest error:', String((err && err.message) || err));
    res.status(502).json({ ok: false, error: 'send_error', detail: String((err && err.message) || err) });
  } finally {
    clearTimeout(timeout);
  }
};
