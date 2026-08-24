// api/unsubscribe.js
//
// Handles the "unsubscribe" link included at the bottom of every digest
// email. Visiting the link (a plain GET request, no login) removes that one
// address from the subscriber list and shows a friendly confirmation page.
//
// The link includes a signed token (built with the same CRON_SECRET used to
// protect api/send-digest.js) so a stranger can't unsubscribe someone else
// just by guessing their email address.

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function unsubscribeToken(email) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`unsub:${email}`).digest('hex');
}

function verifyToken(email, token) {
  const expected = unsubscribeToken(email);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function upstash(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const path = command.map((part) => encodeURIComponent(part)).join('/');
  const res = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data ? data.result : null;
}

function page(title, message) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Cosmic Newsseller</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#0c1330;color:#e8ecf7;padding:24px;}
  .card{max-width:440px;text-align:center;background:#232e5c;border-radius:16px;
    padding:36px 30px;box-shadow:0 8px 24px rgba(0,0,0,.3);}
  h1{font-size:1.35rem;margin:0 0 12px;}
  p{margin:0;color:#b7c0dd;line-height:1.55;}
  a{color:#ffb86b;}
</style>
</head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p></div></body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');

  const email = String((req.query && req.query.email) || '').trim().toLowerCase();
  const token = req.query && req.query.token;

  if (!email || !EMAIL_RE.test(email) || !verifyToken(email, token)) {
    res.status(400).send(page(
      'Link not valid',
      "This unsubscribe link is missing something or doesn&rsquo;t match our records. " +
      "If you meant to unsubscribe, just reply to any Cosmic Newsseller email and we&rsquo;ll remove you by hand."
    ));
    return;
  }

  const result = await upstash(['srem', 'subscribers', email]);
  if (result === null) {
    res.status(502).send(page(
      'Something went wrong',
      "We couldn&rsquo;t reach our subscriber list just now. Please try this link again in a minute."
    ));
    return;
  }

  res.status(200).send(page(
    "You're unsubscribed",
    `${escapeHtml(email)} won&rsquo;t receive any more Cosmic Newsseller emails. Sorry to see you go &mdash; you&rsquo;re welcome back any time.`
  ));
};
