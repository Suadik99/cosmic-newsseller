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

// gemini-2.5-flash-lite is Google's fastest, lightest, most free-tier-
// friendly model. Bigger "flash" models (2.5-flash, 3.x-flash) have a
// "thinking" step that's supposed to be turned off by thinkingBudget: 0
// below, but that's an unreliable known bug on several Flash models -- it
// can silently keep thinking anyway, causing multi-minute replies and
// eventual 503 "model is overloaded" errors. The lite tier avoids that
// class of problem entirely, which is what this chat widget needs.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
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

  // Don't let one slow/stuck request hang the visitor for minutes. If
  // Gemini hasn't responded within 25 seconds, give up and show a friendly
  // "try again" message instead of leaving the chat widget stuck spinning.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    // The key goes right in the address (?key=...) -- the same way it works
    // when pasted into a browser URL -- rather than in a request header.
    // Some newer-format Gemini keys aren't recognized via the header.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.7,
          // Belt-and-suspenders: ask for no "thinking" pass. On the
          // flash-lite model above this should be a no-op (thinking isn't
          // part of that tier), but it's harmless to include.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      // TEMPORARY debug line -- shows Google's exact response in Vercel's
      // Logs. Deliberately does NOT log `url`, since it now contains the
      // API key as a query parameter.
      console.error('[cosmic-bear-debug] model=', GEMINI_MODEL, 'status=', upstream.status, 'body=', errText.slice(0, 300));
      // 503 means Google's servers are temporarily overloaded -- common on
      // the free tier during high demand. Give the visitor a plain-language
      // message instead of a raw error code, and a lighter HTTP status so
      // the widget doesn't treat it as fatal.
      if (upstream.status === 503) {
        res.status(200).json({
          reply: "Mission control is getting a lot of traffic right now and couldn't get back to me in time. Give it a few seconds and try asking again?",
        });
        return;
      }
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
    // AbortError means our own 25-second timeout above fired -- Gemini was
    // taking too long. Show a friendly message rather than a raw error.
    if (err && err.name === 'AbortError') {
      res.status(200).json({
        reply: "Sorry, that's taking longer than it should. Mind trying again in a moment?",
      });
      return;
    }
    res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  } finally {
    clearTimeout(timeout);
  }
};
