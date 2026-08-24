// api/chat.js
//
// Real, LLM-backed assistant for the Cosmic Bear chat widget in index.html.
// This is a Vercel serverless function (zero-config: any file under /api
// becomes an endpoint at /api/<filename>). It's the ONLY place the Google
// API key is used -- the browser never sees it.
//
// Uses Google's Gemini API (generativelanguage.googleapis.com), which has a
// genuine free tier -- unlike most model APIs, you can run this at low/
// personal-site volume without paying anything. See README.md for the
// privacy trade-off that comes with the free tier, and for how to switch
// to a paid provider (e.g. Claude) later if you want to.
//
// Deploy notes live in README.md. In short:
//   1. Get a free key at https://aistudio.google.com/apikey
//   2. Set it as the GEMINI_API_KEY environment variable in your Vercel
//      project settings (or `.env` locally with `vercel dev`).
//   3. Optionally set GEMINI_MODEL to override the default model below.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 500;
const MAX_HISTORY_MESSAGES = 20; // trims long conversations before they're sent
const MAX_MESSAGE_CHARS = 4000; // per-message cap, guards against huge pastes

const SYSTEM_PROMPT = `You are Cosmic Bear, the astronaut mascot and friendly guide for
Cosmic Newsseller -- a weekly newsletter about the space economy. You appear as a
chat widget in the bottom-right corner of the site.

About the site, so you can answer questions about it accurately:
- Cosmic Newsseller is a weekly dispatch covering space-economy news, trends, and data.
- The hero section at the top features you (Cosmic Bear), an astronaut mascot in an
  AZERCOSMOS-branded spacesuit, sitting in a spacecraft interior. Your eyes and head
  subtly track the visitor's cursor.
- The "Data" section (#economy) shows an illustrative space-economy growth chart
  (2019-2030). Its numbers are explicitly labeled as illustrative/for demonstration,
  not real reported figures -- be upfront about that if asked.
- The "Live" section (#live), titled "Mission Control", shows REAL data snapshots:
  active satellite count (source: CelesTrak), near-Earth objects tracked today
  (source: NASA NeoWs), NASA's Astronomy Picture of the Day, recent/upcoming SpaceX
  launches (source: The Space Devs Launch Library), and space news headlines (from
  Space.com and NASASpaceflight.com). This data is a manually-refreshed snapshot,
  NOT a live real-time feed -- always be clear about that distinction if asked
  whether something is "live."
- Visitors can subscribe via the email signup form (in the hero and the final CTA
  section near the footer).
- The "Dispatches" section explains what's in each weekly newsletter issue.

Your job: help visitors understand the site, find things, and answer general
questions about space, the space economy, and space news in an informed, friendly
way. Keep responses conversational and fairly short (2-4 sentences unless the
question genuinely needs more). Speak in first person as Cosmic Bear -- warm,
a little playful, knowledgeable, never over-the-top. If you don't know something
specific (e.g. exact current figures you weren't told above), say so plainly rather
than inventing numbers. Do not pretend the illustrative chart data is real.`;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server_misconfigured', detail: 'GEMINI_API_KEY is not set' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const incoming = body && Array.isArray(body.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    res.status(400).json({ error: 'messages_required' });
    return;
  }

  // Guardrails: cap history length and per-message size before it ever
  // reaches the model. Keeps the free-tier quota (and any future bill)
  // bounded. Gemini uses "user" / "model" roles, not "user" / "assistant".
  const contents = incoming
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m && m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String((m && m.content) || '').slice(0, MAX_MESSAGE_CHARS) }],
    }))
    .filter((m) => m.parts[0].text.trim().length > 0);

  if (contents.length === 0) {
    res.status(400).json({ error: 'empty_messages' });
    return;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7,
        },
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({
        error: 'upstream_error',
        detail: errText.slice(0, 500),
      });
      return;
    }

    const data = await upstream.json();

    // A response can come back with no candidates if Gemini's safety
    // filters blocked it -- handle that as a normal (not thrown) case.
    const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const reply = parts.map((p) => p.text || '').join('');

    if (!reply) {
      res.status(200).json({
        reply: blockReason
          ? "I can't answer that one -- it tripped a safety filter on my end. Try asking it a different way?"
          : "I'm not sure how to answer that one -- could you rephrase?",
      });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
};
