// api/send-digest.js
//
// Builds and sends the actual weekly "Cosmic Newsseller" digest email to
// everyone on the subscriber list. This is triggered automatically once a
// week by Vercel Cron (see the "crons" section in vercel.json) -- nobody
// has to click a button for it to go out.
//
// What it needs to work:
//   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (subscriber list --
//     same database api/subscribe.js writes to)
//   - RESEND_API_KEY   (a free key from https://resend.com -- this is what
//     actually sends the email)
//   - CRON_SECRET       (protects this endpoint from being triggered by
//     anyone but Vercel's own scheduler, or you manually while testing)
// Optional:
//   - RESEND_FROM_EMAIL (defaults to a Resend test sender that can only
//     email your OWN address until you verify a real domain -- see
//     README.md)
//   - SITE_URL          (defaults to the production URL below)
//
// See README.md for the full setup walkthrough, including why a real
// domain is required before you can email anyone but yourself.

const DEFAULT_SITE_URL = 'https://cosmic-newsseller.vercel.app';
const DEFAULT_FROM = 'Cosmic Newsseller <onboarding@resend.dev>';
const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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

async function upstash(command, ms = 8000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const path = command.map((part) => encodeURIComponent(part)).join('/');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${url}/${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data ? data.result : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- gather the same kind of data Mission Control shows on the site ----

async function getSatellites() {
  const data = await safeFetchJson(
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
    15000
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  return { count: data.length };
}

async function getNeo() {
  const data = await safeFetchJson(
    `https://api.nasa.gov/neo/rest/v1/feed/today?detailed=false&api_key=${encodeURIComponent(NASA_API_KEY)}`
  );
  if (!data || !data.near_earth_objects) return null;
  const all = Object.values(data.near_earth_objects).flat();
  return { count: all.length };
}

async function getApod() {
  const data = await safeFetchJson(
    `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(NASA_API_KEY)}`
  );
  if (!data || data.media_type !== 'image' || !data.url) return null;
  return {
    title: data.title || 'NASA Astronomy Picture of the Day',
    imageUrl: data.url,
    permalink: `https://apod.nasa.gov/apod/ap${String(data.date || '').replace(/-/g, '').slice(2)}.html`,
    explanation: String(data.explanation || '').slice(0, 220),
    credit: data.copyright ? String(data.copyright).trim() : 'NASA',
  };
}

async function getLaunches() {
  const data = await safeFetchJson(
    'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?lsp__name=SpaceX&limit=3&ordering=net'
  );
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
  return data.results.map((a) => ({
    title: a.title,
    url: a.url,
    site: a.news_site || 'Space news',
  }));
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

// ---- build the email ----

function buildSubject(issueDate) {
  return `Cosmic Newsseller — Space Digest for ${issueDate}`;
}

function buildEmailHtml(data, issueDate, siteUrl, unsubscribeUrl) {
  const apodBlock = data.apod ? `
    <tr><td style="padding:0 28px 20px;">
      <img src="${escapeHtml(data.apod.imageUrl)}" alt="${escapeHtml(data.apod.title)}" width="100%"
        style="display:block;width:100%;max-width:100%;border-radius:12px;margin:0 0 12px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#1d2650;">${escapeHtml(data.apod.title)}</p>
      <p style="margin:0 0 6px;font-size:13.5px;line-height:1.5;color:#4a5578;">${escapeHtml(data.apod.explanation)}${data.apod.explanation.length >= 220 ? '…' : ''}</p>
      <p style="margin:0;font-size:12px;color:#8891ad;">Image credit: ${escapeHtml(data.apod.credit)} · NASA APOD ·
        <a href="${escapeHtml(data.apod.permalink)}" style="color:#c17a1f;">See full picture</a></p>
    </td></tr>` : '';

  const statsBlock = `
    <tr><td style="padding:0 28px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" style="padding:14px;background:#f3f0e9;border-radius:10px;" align="center">
          <div style="font-size:22px;font-weight:700;color:#1d2650;">${data.satellites ? data.satellites.count.toLocaleString('en-US') : '—'}</div>
          <div style="font-size:12px;color:#7a8399;margin-top:2px;">Active satellites</div>
        </td>
        <td width="12"></td>
        <td width="50%" style="padding:14px;background:#f3f0e9;border-radius:10px;" align="center">
          <div style="font-size:22px;font-weight:700;color:#1d2650;">${data.neo ? data.neo.count : '—'}</div>
          <div style="font-size:12px;color:#7a8399;margin-top:2px;">Near-Earth objects today</div>
        </td>
      </tr></table>
    </td></tr>`;

  const launchRows = data.launches.length
    ? data.launches.map((l) => `
      <tr><td style="padding:0 0 12px;border-bottom:1px solid #ece8de;">
        <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#1d2650;">${escapeHtml(l.name)}</p>
        <p style="margin:0;font-size:12.5px;color:#8891ad;">${escapeHtml(fmtLaunchDate(l.net))}${l.pad ? ' · ' + escapeHtml(l.pad) : ''}</p>
      </td></tr>`).join('')
    : '<tr><td style="padding:0 0 12px;font-size:13.5px;color:#8891ad;">No upcoming launches on file right now.</td></tr>';

  const newsRows = data.news.length
    ? data.news.map((n) => `
      <tr><td style="padding:0 0 14px;">
        <a href="${escapeHtml(n.url)}" style="font-size:14.5px;font-weight:600;color:#1d2650;text-decoration:none;">${escapeHtml(n.title)}</a>
        <p style="margin:2px 0 0;font-size:12.5px;color:#8891ad;">${escapeHtml(n.site)}</p>
      </td></tr>`).join('')
    : '<tr><td style="padding:0 0 14px;font-size:13.5px;color:#8891ad;">No fresh headlines came through this time -- check the site for the latest.</td></tr>';

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e9e5da;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e5da;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">

  <tr><td style="background:#1d2650;padding:26px 28px;">
    <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#ffb86b;">Transmission incoming</p>
    <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;">🛰️ Cosmic Newsseller</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#b7c0dd;">Space digest for ${escapeHtml(issueDate)}</p>
  </td></tr>

  <tr><td style="padding:24px 28px 4px;">
    <p style="margin:0;font-size:14.5px;line-height:1.55;color:#4a5578;">Hey, it's Cosmic Bear 🐻🚀 -- here's what happened in orbit this week, straight from the same live feeds that power the site.</p>
  </td></tr>
  <tr><td style="height:20px;"></td></tr>

  ${apodBlock}
  ${statsBlock}

  <tr><td style="padding:0 28px 8px;">
    <p style="margin:0 0 12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8891ad;">Upcoming launches</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${launchRows}</table>
  </td></tr>
  <tr><td style="height:8px;"></td></tr>

  <tr><td style="padding:0 28px 8px;">
    <p style="margin:0 0 12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8891ad;">Space news this week</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${newsRows}</table>
  </td></tr>

  <tr><td style="padding:22px 28px;background:#f3f0e9;" align="center">
    <a href="${escapeHtml(siteUrl)}" style="display:inline-block;background:#1d2650;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:600;padding:11px 22px;border-radius:8px;">Visit Cosmic Newsseller</a>
  </td></tr>

  <tr><td style="padding:18px 28px 26px;" align="center">
    <p style="margin:0;font-size:11.5px;color:#a3abc2;line-height:1.6;">
      You're getting this because you subscribed at ${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}.<br>
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#a3abc2;">Unsubscribe</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildEmailText(data, issueDate, siteUrl, unsubscribeUrl) {
  const lines = [];
  lines.push(`COSMIC NEWSSELLER -- Space digest for ${issueDate}`);
  lines.push('');
  if (data.apod) {
    lines.push(`Picture of the day: ${data.apod.title}`);
    lines.push(data.apod.permalink);
    lines.push('');
  }
  lines.push('Upcoming launches:');
  data.launches.forEach((l) => lines.push(`- ${l.name} (${fmtLaunchDate(l.net)})`));
  lines.push('');
  lines.push('Space news this week:');
  data.news.forEach((n) => lines.push(`- ${n.title} (${n.site}) ${n.url}`));
  lines.push('');
  lines.push(`Visit: ${siteUrl}`);
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  return lines.join('\n');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const crypto = require('crypto');
function unsubscribeToken(email) {
  const secret = process.env.CRON_SECRET || '';
  return crypto.createHmac('sha256', secret).update(`unsub:${email}`).digest('hex');
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  // --- auth: only Vercel's own scheduler (which sends this header
  // automatically -- see README.md) or someone who knows CRON_SECRET may
  // trigger a real send. A `?secret=...` query param is also accepted so
  // you can trigger a manual test run by just visiting a URL in a browser.
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

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({ error: 'server_misconfigured', detail: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set' });
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    res.status(500).json({ error: 'server_misconfigured', detail: 'RESEND_API_KEY is not set' });
    return;
  }

  const subscribers = await upstash(['smembers', 'subscribers']);
  if (subscribers === null) {
    res.status(502).json({ error: 'storage_error' });
    return;
  }
  if (!Array.isArray(subscribers) || subscribers.length === 0) {
    res.status(200).json({ ok: true, subscribers: 0, sent: 0, detail: 'No subscribers yet -- nothing to send.' });
    return;
  }

  const [satellites, neo, apod, launches, news] = await Promise.all([
    getSatellites(), getNeo(), getApod(), getLaunches(), getNews(),
  ]);
  const data = { satellites, neo, apod, launches, news };

  const siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL;
  const fromEmail = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;
  const issueDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const subject = buildSubject(issueDate);

  const batches = chunk(subscribers, 100);
  let sent = 0;
  const failedBatches = [];

  for (const batch of batches) {
    const emails = batch.map((email) => {
      const unsubscribeUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
      return {
        from: fromEmail,
        to: [email],
        subject,
        html: buildEmailHtml(data, issueDate, siteUrl, unsubscribeUrl),
        text: buildEmailText(data, issueDate, siteUrl, unsubscribeUrl),
      };
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstreamRes = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify(emails),
      });
      if (upstreamRes.ok) {
        sent += batch.length;
      } else {
        const errText = await upstreamRes.text().catch(() => '');
        failedBatches.push({ size: batch.length, status: upstreamRes.status, detail: errText.slice(0, 300) });
      }
    } catch (err) {
      failedBatches.push({ size: batch.length, error: String((err && err.message) || err) });
    } finally {
      clearTimeout(timeout);
    }
  }

  res.status(200).json({
    ok: failedBatches.length === 0,
    subscribers: subscribers.length,
    sent,
    failedBatches,
  });
};
