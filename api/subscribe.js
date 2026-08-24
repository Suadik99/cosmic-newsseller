// api/subscribe.js
//
// Saves an email address when someone submits one of the "Join the crew" /
// "Subscribe for free" forms on the site. This is what makes the signup
// form actually do something -- before this existed, the forms had nowhere
// to send the address.
//
// Storage: a free Upstash Redis database (Vercel serverless functions don't
// remember anything between requests, so something outside the function has
// to hold the subscriber list). Get a free database at https://upstash.com,
// then set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as
// environment variables in Vercel. See README.md for the full walkthrough.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Talk to Upstash's REST API with a plain fetch call -- no extra npm
// package needed. Each element of `command` becomes one segment of the
// URL path, e.g. ['sadd', 'subscribers', 'a@b.com'] -> POST /sadd/subscribers/a%40b.com
async function upstash(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const path = command.map((part) => encodeURIComponent(part)).join('/');
  const res = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // Temporary debug line -- shows up in Vercel's Logs tab so we can see
    // exactly why the Upstash call failed. Safe to remove once this is
    // working reliably.
    const errText = await res.text().catch(() => '');
    console.error('[cosmic-bear-debug] upstash call failed: status=', res.status, 'body=', errText.slice(0, 300));
    return null;
  }
  const data = await res.json().catch(() => null);
  return data ? data.result : null;
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

  // result === 1 means newly added, 0 means they were already subscribed --
  // either way, from the visitor's point of view, it worked.
  res.status(200).json({ ok: true });
};
