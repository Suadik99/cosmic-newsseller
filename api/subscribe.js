// api/subscribe.js
//
// Saves an email address when someone submits one of the "Join the crew" /
// "Subscribe for free" forms on the site.
//
// This uses Buttondown (https://buttondown.com) as the actual newsletter
// platform -- it's free for your first 100 subscribers and, unlike sending
// email yourself (e.g. via Resend/SendGrid/SES), it can deliver to ANYONE
// without you needing to own and verify a domain. That's the trade-off:
// free + works for real subscribers, but on the free plan the email uses
// Buttondown's own built-in theme rather than a fully custom design.
//
// Setup: create a free account at https://buttondown.com, find your API
// key at https://buttondown.com/settings/api, and set it as
// BUTTONDOWN_API_KEY in Vercel. See README.md for the full walkthrough.
//
// New subscribers are added WITHOUT setting type:"regular", which means
// Buttondown automatically sends its own confirmation email right away
// (free, built-in, no code needed here) -- that's the "you get something
// immediately" moment. Once they confirm, they're included in every
// regular weekly digest api/send-digest.js sends from then on.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!process.env.BUTTONDOWN_API_KEY) {
    res.status(500).json({
      error: 'server_misconfigured',
      detail: 'BUTTONDOWN_API_KEY is not set',
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch('https://api.buttondown.com/v1/subscribers', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Token ${process.env.BUTTONDOWN_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email_address: email }),
    });

    if (upstream.status === 201) {
      res.status(200).json({ ok: true });
      return;
    }

    const errText = await upstream.text().catch(() => '');

    // Buttondown returns a 4xx error if this address is already on the
    // list -- from the visitor's point of view that's still a success
    // (they're subscribed either way), so don't show them an error.
    if (upstream.status >= 400 && upstream.status < 500 && /already|exist|duplicate/i.test(errText)) {
      res.status(200).json({ ok: true });
      return;
    }

    console.error('[cosmic-bear-debug] buttondown subscribe failed: status=', upstream.status, 'body=', errText.slice(0, 300));
    res.status(502).json({ error: 'storage_error' });
  } catch (err) {
    console.error('[cosmic-bear-debug] buttondown subscribe error:', String((err && err.message) || err));
    res.status(502).json({ error: 'storage_error' });
  } finally {
    clearTimeout(timeout);
  }
};
