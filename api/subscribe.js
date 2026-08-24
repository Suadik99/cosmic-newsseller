// api/subscribe.js
//
// Saves an email address when someone submits one of the "Join the crew" /
// "Subscribe for free" forms on the site, and immediately sends them a
// welcome digest so they don't have to wait until the next scheduled send
// (api/send-digest.js still sends the same kind of digest to everyone,
// including this subscriber, every Monday going forward).
//
// Storage: a free Upstash Redis database (Vercel serverless functions don't
// remember anything between requests, so something outside the function has
// to hold the subscriber list). Get a free database at https://upstash.com,
// then set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as
// environment variables in Vercel.
//
// Sending the welcome email needs RESEND_API_KEY and CRON_SECRET too (the
// same ones api/send-digest.js uses -- see README.md for the full
// walkthrough). If those aren't set yet, or the send fails for any reason,
// the subscription itself still succeeds -- a visitor should never see an
// error just because the welcome email had trouble going out.

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SITE_URL = 'https://cosmic-newsseller.vercel.app';
const DEFAULT_FROM = 'Cosmic Newsseller <onboarding@resend.dev>';
const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- Upstash (subscriber storage) ----

async function upstash(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const path = command.map((part) => encodeURIComponent(part)).join('/');
  const res = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('[cosmic-bear-debug] upstash call failed: status=', res.status, 'body=', errText.slice(0, 300));
    return null;
  }
  const data = await res.json().catch(() => null);
  return data ? data.result : null;
}

// ---- same live space-data feeds Mission Control / the weekly digest use ----

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
    explanation: String(data.explanation || '').slice(0, 220),
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

function unsubscribeToken(email) {
  const secret = process.env.CRON_SECRET || '';
  return crypto.createHmac('sha256', secret).update(`unsub:${email}`).digest('hex');
}

// ---- build the welcome email (same visual template as the weekly digest) ----

function buildWelcomeEmailHtml(data, issueDate, siteUrl, unsubscribeUrl) {
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
    <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#ffb86b;">Welcome aboard</p>
    <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;">🛰️ Cosmic Newsseller</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#b7c0dd;">Your first digest &middot; ${escapeHtml(issueDate)}</p>
  </td></tr>

  <tr><td style="padding:24px 28px 4px;">
    <p style="margin:0;font-size:14.5px;line-height:1.55;color:#4a5578;">Hey, it's Cosmic Bear 🐻🚀 -- thanks for joining the crew! Here's a snapshot of what's happening in orbit right now, from the same live feeds that power the site. You'll get a fresh one like this every Monday from here on.</p>
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
      You're getting this because you just subscribed at ${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}.<br>
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#a3abc2;">Unsubscribe</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildWelcomeEmailText(data, issueDate, siteUrl, unsubscribeUrl) {
  const lines = [];
  lines.push(`COSMIC NEWSSELLER -- your first digest (${issueDate})`);
  lines.push('');
  lines.push("Thanks for joining! You'll get a fresh one of these every Monday.");
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

// Best-effort: gathers the live data and sends one welcome email via Resend.
// Never throws -- a problem here should not turn into an error for the
// visitor, since their subscription already succeeded before this runs.
async function sendWelcomeEmail(email) {
  if (!process.env.RESEND_API_KEY || !process.env.CRON_SECRET) {
    console.error('[cosmic-bear-debug] skipping welcome email: RESEND_API_KEY or CRON_SECRET not set');
    return;
  }
  try {
    const [satellites, neo, apod, launches, news] = await Promise.all([
      getSatellites(), getNeo(), getApod(), getLaunches(), getNews(),
    ]);
    const data = { satellites, neo, apod, launches, news };
    const siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;
    const issueDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const unsubscribeUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const upstreamRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [email],
          subject: 'Welcome aboard — your first Cosmic Newsseller digest 🚀',
          html: buildWelcomeEmailHtml(data, issueDate, siteUrl, unsubscribeUrl),
          text: buildWelcomeEmailText(data, issueDate, siteUrl, unsubscribeUrl),
        }),
      });
      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        console.error('[cosmic-bear-debug] resend welcome email failed: status=', upstreamRes.status, 'body=', errText.slice(0, 300));
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('[cosmic-bear-debug] welcome email error:', String((err && err.message) || err));
  }
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({
      error: 'server_misconfigured',
      detail: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const rawEmail = body && typeof body.email === 'string' ? body.email : '';
  const email = rawEmail.trim().toLowerCase();

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }

  const result = await upstash(['sadd', 'subscribers', email]);
  if (result === null) {
    res.status(502).json({ error: 'storage_error' });
    return;
  }

  // result === 1 means they were newly added (send the welcome email);
  // result === 0 means they were already subscribed (don't re-send).
  if (result === 1) {
    await sendWelcomeEmail(email);
  }

  res.status(200).json({ ok: true });
};
