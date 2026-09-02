// api/send-digest.js
//
// Sends the weekly Cosmic Newsseller email AUTOMATICALLY, with no manual editing.
// A Vercel Cron Job (see vercel.json) calls this file on a schedule. Each time it runs, it:
//   1. Pulls this week's real data from this site's own /api/mission-control endpoint
//      (satellites, near-Earth objects, launches, space weather, and real news headlines).
//   2. Picks a "top story" and a handful of "also this week" items from the real news feed.
//   3. Builds the four stat numbers from real data.
//   4. Optionally asks Claude to write Cosmic Bear's two short blurbs in-voice, using that
//      week's real story and numbers (only if ANTHROPIC_API_KEY + ANTHROPIC_MODEL are both
//      set — otherwise a simple built-in fallback sentence is used, so a send never fails
//      because of this step).
//   5. Drops everything into the HTML email design and sends it through MailerLite.
//
// ── Environment variables to set in Vercel → Settings → Environment Variables ──────────
//   CRON_SECRET            Already used elsewhere in this project. Vercel automatically
//                          sends this as the Authorization header when the cron job fires,
//                          so this endpoint can confirm the request is really from Vercel.
//   SITE_URL               Your site's full address, e.g. https://cosmic-newsseller.vercel.app
//   MAILERLITE_API_KEY     MailerLite dashboard → Integrations → Developer API → generate a token.
//   MAILERLITE_GROUP_ID    MailerLite dashboard → Subscribers → Groups → open your list → the
//                          ID is in the page's web address, e.g. .../groups/123456789012345678
//   MAILERLITE_FROM_EMAIL  A sender email verified in MailerLite (Campaigns → Settings, or
//                          under Domains). MailerLite will reject sends from an unverified address.
//   MAILERLITE_FROM_NAME   Optional. Defaults to "Cosmic Bear".
//   ANTHROPIC_API_KEY      Optional. Only used if ANTHROPIC_MODEL is ALSO set.
//   ANTHROPIC_MODEL        Optional. The exact model name your api/chat.js already uses.
//                          Leave both of these unset to always use the safe fallback copy.
//
// ── IMPORTANT — legal requirement, not optional ────────────────────────────────────────
// Every commercial email must show a real postal mailing address. Open the HTML template
// below and replace [Street Address], [City, State ZIP], [Country] with your real address
// before this goes live. This is a US CAN-SPAM / general anti-spam law requirement, not a
// MailerLite rule — sending without it is a legal problem, not just a technical one.

const MAILERLITE_BASE = 'https://connect.mailerlite.com/api';
const FIRST_ISSUE_MONDAY_UTC = Date.UTC(2026, 0, 5); // adjust this once, to your real Issue 1 date

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

async function safeFetchJson(url, opts = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* leave null, raw text still returned */ }
    return { ok: res.ok, status: res.status, data, raw: text };
  } catch (e) {
    return { ok: false, status: 0, data: null, raw: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- issue number & date label, no database required ----------
function currentIssueNumber(now = new Date()) {
  const weeks = Math.floor((now.getTime() - FIRST_ISSUE_MONDAY_UTC) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, weeks + 1);
}
function currentWeekLabel(now = new Date()) {
  return now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ---------- pull this week's real data from the site's own mission-control endpoint ----------
async function getWeeklyData() {
  const site = (process.env.SITE_URL || 'https://cosmic-newsseller.vercel.app').replace(/\/$/, '');
  const r = await safeFetchJson(`${site}/api/mission-control`, {}, 15000);
  return r.data || {};
}

function pickStories(news) {
  const list = Array.isArray(news) ? news.filter(Boolean) : [];
  return { top: list[0] || null, rest: list.slice(1, 6) };
}

function buildStats(d) {
  const stats = [];
  if (d.launches && Array.isArray(d.launches.upcoming)) {
    stats.push({ value: String(d.launches.upcoming.length), label: 'Launches on the manifest' });
  }
  if (d.satellites && typeof d.satellites.count === 'number') {
    stats.push({ value: d.satellites.count.toLocaleString('en-US'), label: 'Active satellites tracked' });
  }
  if (d.neo && typeof d.neo.count === 'number') {
    stats.push({ value: String(d.neo.count), label: 'Near-Earth objects this week' });
  }
  if (d.spaceWeather && typeof d.spaceWeather.flareCount === 'number') {
    stats.push({ value: String(d.spaceWeather.flareCount), label: 'Solar flares this week' });
  }
  // Evergreen backup so the row is never left short if a live source is briefly down.
  while (stats.length < 4) {
    stats.push({ value: '$1.18T', label: 'Projected space economy, 2030' });
  }
  return stats.slice(0, 4);
}

// ---------- Cosmic Bear's two short blurbs: Claude-written if configured, else a safe fallback ----------
async function writeBearCopy({ topStory, stats }) {
  const fallback = {
    intro: "Morning from low Earth orbit. Here's what actually mattered this week, no jargon required.",
    take: "Every week the pattern looks the same: someone finds a cheaper or steadier way to do something that used to be expensive and fragile. That's the real story of this industry right now, one small improvement at a time.",
  };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL || !topStory) return fallback;

  const prompt = `You are Cosmic Bear, the friendly astronaut-bear mascot who writes a weekly space-news email called Cosmic Newsseller. Write two short pieces of copy for this week's issue, in a warm, plain-spoken, lightly playful voice. No emoji, no exclamation-point overload.

This week's top story: "${topStory.title}" — ${topStory.summary || ''}

This week's numbers: ${stats.map((s) => `${s.value} ${s.label}`).join('; ')}

Return ONLY valid JSON, no markdown fences, in exactly this shape:
{"intro": "2-3 sentence opening line for the email, referencing the top story naturally", "take": "one short paragraph (3-4 sentences) giving your own take on why this week's news matters"}`;

  try {
    const r = await safeFetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 20000);
    const text = r.data && r.data.content && r.data.content[0] && r.data.content[0].text;
    if (!text) return fallback;
    const parsed = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ''));
    if (!parsed.intro || !parsed.take) return fallback;
    return parsed;
  } catch (e) {
    return fallback;
  }
}

// ---------- build the actual email HTML (same design as the approved template) ----------
function renderEmailHtml({ issueNumber, weekLabel, top, rest, stats, bear }) {
  const heroImg = top && top.imageUrl
    ? `<img src="${esc(top.imageUrl)}" width="536" height="240" alt="${esc(truncate(top.title || '', 140))}" style="display:block;width:100%;max-width:536px;height:240px;object-fit:cover;border:0;border-radius:8px;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="bg-tint edge" style="background-color:#f2f0fb;border:1px solid #ddd9f2;border-radius:8px;">
         <tr><td class="hero" align="center" valign="middle" height="240" style="height:240px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:#7a6fc4;letter-spacing:1px;">COSMIC NEWSSELLER</td></tr>
       </table>`;

  const topTitle = top ? esc(top.title) : 'This week in space';
  const topSummary = top ? esc(truncate(top.summary || '', 320)) : 'Check back next week for the latest dispatch.';
  const topUrl = (top && top.url) || (process.env.SITE_URL || 'https://cosmic-newsseller.vercel.app');
  const preheader = top ? esc(truncate(top.title, 140)) : 'This week’s space news dispatch is here.';

  const statCells = stats.map((s) => `
        <td class="stat" width="134" valign="top" style="padding-right:12px;font-family:Arial,Helvetica,sans-serif;">
          <div class="t-strong" style="font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:29px;mso-line-height-rule:exactly;color:#1c1d2b;font-weight:bold;">${esc(s.value)}</div>
          <div class="t-mute" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:17px;mso-line-height-rule:exactly;color:#75788c;padding-top:5px;">${esc(s.label)}</div>
        </td>`).join('');

  const alsoRows = (rest.length ? rest : []).map((item, i) => `
      <tr><td valign="top" style="font-family:Arial,Helvetica,sans-serif;padding-bottom:${i === rest.length - 1 ? 0 : 18}px;">
        <div class="t-strong" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;mso-line-height-rule:exactly;color:#1c1d2b;font-weight:bold;">${esc(item.title)}</div>
        <div class="t-body" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;mso-line-height-rule:exactly;color:#4a4c5e;padding-top:4px;">${esc(truncate(item.summary || '', 200))}</div>
        <div style="padding-top:5px;"><a href="${esc(item.url || '#')}" class="link" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;mso-line-height-rule:exactly;color:#6f61c2;text-decoration:underline;">Read more &rarr;</a></div>
      </td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cosmic Newsseller — Issue ${issueNumber}</title>
<!--[if mso]>
<style>body,table,td,a,div,span{font-family:Arial,Helvetica,sans-serif !important;}</style>
<![endif]-->
<style>
  @media only screen and (max-width:620px){
    .container{width:100% !important;}
    .px{padding-left:20px !important;padding-right:20px !important;}
    .stat{display:block !important;width:100% !important;padding:0 0 14px 0 !important;}
    .h1{font-size:26px !important;line-height:32px !important;}
    .hero{height:180px !important;}
  }
  @media (prefers-color-scheme:dark){
    .bg-outer{background-color:#101120 !important;}
    .bg-card{background-color:#161826 !important;}
    .bg-tint{background-color:#1d1f30 !important;}
    .t-strong{color:#e9e9ed !important;}
    .t-body{color:#b6b8ca !important;}
    .t-mute{color:#8b8ea6 !important;}
    .rule{background-color:#2b2d42 !important;}
    .edge{border-color:#2b2d42 !important;}
    .link{color:#b3a9ea !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f7f7f9;">

<div style="display:none;font-size:1px;color:#f7f7f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="bg-outer" style="background-color:#f7f7f9;">
<tr><td align="center" style="padding:24px 12px 40px 12px;">

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container bg-card edge" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e4e4ea;border-radius:8px;">

  <tr><td class="px" style="padding:24px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="40" valign="middle" style="padding-right:12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="40" style="width:40px;">
            <tr><td align="center" valign="middle" height="40" class="bg-tint edge" style="width:40px;height:40px;background-color:#f2f0fb;border:1px solid #d8d3f0;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:18px;mso-line-height-rule:exactly;color:#6f61c2;font-weight:bold;letter-spacing:0.5px;">CB</td></tr>
          </table>
        </td>
        <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;">
          <div class="t-strong" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:19px;mso-line-height-rule:exactly;color:#1c1d2b;font-weight:bold;letter-spacing:1.5px;">COSMIC NEWSSELLER</div>
          <div class="t-mute" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:17px;mso-line-height-rule:exactly;color:#75788c;padding-top:3px;">Weekly dispatch, narrated by Cosmic Bear</div>
        </td>
        <td valign="middle" align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;mso-line-height-rule:exactly;color:#6f61c2;letter-spacing:1px;" class="link">ISSUE ${issueNumber}<br><span class="t-mute" style="color:#75788c;letter-spacing:0.5px;">WEEK OF ${esc(weekLabel).toUpperCase()}</span></td>
      </tr>
    </table>
  </td></tr>

  <tr><td class="px" style="padding:20px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td height="2" width="64" style="background-color:#9184d9;font-size:0;line-height:0;">&nbsp;</td>
      <td height="2" class="rule" style="background-color:#ececf1;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>

  <tr><td class="px t-body" style="padding:22px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:#4a4c5e;">
    ${esc(bear.intro)}
  </td></tr>

  <tr><td class="px" style="padding:26px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:1.5px;color:#6f61c2;">TOP STORY</td></tr>

  <tr><td class="px" style="padding:14px 32px 0 32px;">
    ${heroImg}
  </td></tr>

  <tr><td class="px h1 t-strong" style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:35px;mso-line-height-rule:exactly;color:#1c1d2b;font-weight:normal;">${topTitle}</td></tr>
  <tr><td class="px t-body" style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:#4a4c5e;">
    ${topSummary}
  </td></tr>
  <tr><td class="px" style="padding:14px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;mso-line-height-rule:exactly;">
    <a href="${esc(topUrl)}" class="link" style="color:#6f61c2;text-decoration:underline;font-weight:bold;">Read the full story &rarr;</a>
  </td></tr>

  <tr><td class="px" style="padding:30px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td height="1" class="rule" style="background-color:#ececf1;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="padding:22px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:1.5px;color:#6f61c2;">THIS WEEK IN NUMBERS</td></tr>
  <tr><td class="px" style="padding:16px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>${statCells}</tr>
    </table>
  </td></tr>

  ${rest.length ? `
  <tr><td class="px" style="padding:30px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td height="1" class="rule" style="background-color:#ececf1;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="padding:22px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:1.5px;color:#6f61c2;">ALSO THIS WEEK</td></tr>
  <tr><td class="px" style="padding:16px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${alsoRows}
    </table>
  </td></tr>` : ''}

  <tr><td class="px" style="padding:28px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="bg-tint edge" style="background-color:#f4f2fc;border:1px solid #ddd9f2;border-radius:8px;">
      <tr><td style="padding:20px 22px;">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:1.5px;color:#6f61c2;">COSMIC BEAR'S TAKE</div>
        <div class="t-strong" style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:27px;mso-line-height-rule:exactly;color:#26273a;padding-top:10px;">${esc(bear.take)}</div>
        <div class="t-mute" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:#75788c;padding-top:12px;">— Cosmic Bear, somewhere over the Pacific</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td class="px" align="left" style="padding:30px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" bgcolor="#ffffff" class="bg-card" style="border:1px solid #9184d9;border-radius:8px;padding:13px 24px;">
        <a href="${esc(process.env.SITE_URL || 'https://cosmic-newsseller.vercel.app')}" class="link" style="display:block;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;mso-line-height-rule:exactly;color:#6f61c2;text-decoration:none;font-weight:bold;letter-spacing:0.5px;">Browse the full dispatch archive</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td class="px t-mute" style="padding:10px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;mso-line-height-rule:exactly;color:#75788c;">Every issue since 001, plus the live launch and satellite dashboard.</td></tr>

  <tr><td class="px" style="padding:28px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td height="1" class="rule" style="background-color:#ececf1;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="padding:18px 32px 30px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;mso-line-height-rule:exactly;">
    <div>
      <a href="${esc(process.env.SITE_URL || 'https://cosmic-newsseller.vercel.app')}" class="link" style="color:#6f61c2;text-decoration:underline;">Website</a>
      &nbsp;&middot;&nbsp;
      <a href="https://x.com/" class="link" style="color:#6f61c2;text-decoration:underline;">X</a>
      &nbsp;&middot;&nbsp;
      <a href="https://bsky.app/" class="link" style="color:#6f61c2;text-decoration:underline;">Bluesky</a>
    </div>
    <div class="t-mute" style="color:#75788c;padding-top:14px;">
      You are receiving this because you signed up at cosmic-newsseller.vercel.app.<br>
      <a href="{$unsubscribe}" class="link" style="color:#75788c;text-decoration:underline;">Unsubscribe</a>
    </div>
    <div class="t-mute" style="color:#8b8ea6;padding-top:14px;">
      Cosmic Newsseller, [Street Address], [City, State ZIP], [Country]<br>
      &copy; ${new Date().getUTCFullYear()} Cosmic Newsseller. All rights reserved.
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ---------- create + send the campaign through MailerLite ----------
async function mailerliteSend(html, subject) {
  const key = process.env.MAILERLITE_API_KEY;
  const groupId = process.env.MAILERLITE_GROUP_ID;
  const fromEmail = process.env.MAILERLITE_FROM_EMAIL;
  const fromName = process.env.MAILERLITE_FROM_NAME || 'Cosmic Bear';

  if (!key || !groupId || !fromEmail) {
    throw new Error('Missing MailerLite setup: check MAILERLITE_API_KEY, MAILERLITE_GROUP_ID, and MAILERLITE_FROM_EMAIL in Vercel.');
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${key}`,
  };

  const createRes = await safeFetchJson(`${MAILERLITE_BASE}/campaigns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: subject,
      type: 'regular',
      groups: [groupId],
      emails: [{ subject, from_name: fromName, from: fromEmail, content: html }],
    }),
  }, 20000);

  const campaignId = createRes.data && ((createRes.data.data && createRes.data.data.id) || createRes.data.id);
  if (!createRes.ok || !campaignId) {
    throw new Error('MailerLite campaign creation failed: ' + createRes.raw);
  }

  const sendRes = await safeFetchJson(`${MAILERLITE_BASE}/campaigns/${campaignId}/schedule`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ delivery: 'instant' }),
  }, 20000);

  if (!sendRes.ok) {
    throw new Error(`MailerLite campaign ${campaignId} was created but sending failed: ` + sendRes.raw);
  }

  return { campaignId, sendResponse: sendRes.data };
}

// ---------- entry point ----------
module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const querySecret = req.query && req.query.secret;
  const authorized = !!cronSecret && (authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret);

  if (!authorized) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const data = await getWeeklyData();
    const { top, rest } = pickStories(data.news);
    const stats = buildStats(data);
    const bear = await writeBearCopy({ topStory: top, stats });

    const issueNumber = currentIssueNumber();
    const weekLabel = currentWeekLabel();
    const subject = top ? `Issue ${issueNumber}: ${top.title}` : `Cosmic Newsseller — Issue ${issueNumber}`;

    const html = renderEmailHtml({ issueNumber, weekLabel, top, rest, stats, bear });
    const result = await mailerliteSend(html, subject);

    res.status(200).json({ ok: true, issueNumber, subject, topStory: top && top.title, statCount: stats.length, mailerlite: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
