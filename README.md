# Cosmic Newsseller — with a real (free) Cosmic Bear chat assistant

This is a standalone, deployable copy of the Cosmic Newsseller site (same hero,
mascot animation, and Mission Control data section as the published Artifact),
plus one new thing: a **real, LLM-backed chat widget** in the bottom-right
corner, voiced as Cosmic Bear — running on Google's Gemini API, which has a
genuine free tier.

## Why this exists as a separate project

The published Artifact version of this site can't make outbound network calls
on its own — that's a deliberate sandbox restriction, not a bug. A chat
assistant that actually thinks needs a server that holds an API key and calls
a model. So this project adds exactly that: one small serverless function
(`api/chat.js`) that the page talks to, and nothing else changes about how
the site looks or works. Deploy this instead of (or alongside) the Artifact
link if you want the chat to be real.

## What's in here

```
index.html      the whole site: hero, mascot rig, Mission Control, chat widget UI
api/chat.js     serverless function — the only place your API key lives
package.json    minimal, no dependencies
.env.example    copy to .env for local dev
```

No build step, no framework, no dependencies to install. `index.html` is
served as-is; `api/chat.js` becomes a live endpoint automatically on Vercel.

## Why Gemini, and the trade-off to know about

Google's Gemini API has an actual free tier — not just trial credits — so
this can run at a personal site's traffic for $0. The trade-off: on the free
tier, Google may use the conversations sent to it to improve their products.
That's worth disclosing if you ever get asked "is this data private?" — it
isn't, on the free tier. If that matters to you, the **Switching providers**
section below covers moving to a paid, no-training API instead (e.g. Claude).

## Get a free API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Sign in with any Google account, click **Create API key**.
3. Copy it — you'll set it as `GEMINI_API_KEY` wherever you deploy (below).

## Deploy (recommended: Vercel, free tier is enough)

**Option A — Vercel CLI, fastest:**

```bash
npm i -g vercel      # if you don't have it
cd cosmic-newsseller-app
vercel                # first deploy, follow the prompts
vercel env add GEMINI_API_KEY    # paste your key when asked
vercel --prod          # deploy again so the env var takes effect
```

**Option B — GitHub + Vercel dashboard:**

1. Push this folder to a new GitHub repo.
2. In the [Vercel dashboard](https://vercel.com/new), import that repo.
   No build settings needed — Vercel auto-detects a static site + serverless
   functions.
3. In the project's **Settings → Environment Variables**, add
   `GEMINI_API_KEY` with your real key. Redeploy.

Either way, you'll get a live URL (e.g. `your-project.vercel.app`) where
everything — including the chat — actually works. You can point your own
domain at it from the Vercel dashboard whenever you're ready.

**Other hosts:** any platform that supports static files + Node serverless
functions on the same domain works the same way (Netlify Functions,
Cloudflare Pages Functions, etc.) — you'd just move `api/chat.js` into that
platform's expected functions folder and set the same environment variable.

## Local development

```bash
npm i -g vercel
cp .env.example .env      # then edit .env with your real key
vercel dev
```

This runs the static site and the `/api/chat` function together on
`localhost`, exactly like production.

## Customizing Cosmic Bear

Everything about how the assistant answers lives in one place: the
`SYSTEM_PROMPT` constant at the top of `api/chat.js`. It currently describes
the site's sections and tells the model to be upfront about which data is
illustrative vs. real. Edit that text to change Cosmic Bear's tone, add facts
you want it to know, or narrow what it's allowed to talk about.

## Model & free-tier limits

The function defaults to `gemini-2.5-flash`. You can override it by setting
a `GEMINI_MODEL` environment variable (see `.env.example`). Current model
names and free-tier eligibility are always listed at
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) —
check there before launching, since the lineup changes over time. Your actual
free-tier rate limits (requests/minute, requests/day) are visible once you're
signed in at [aistudio.google.com](https://aistudio.google.com).

Each reply is capped at 500 output tokens and conversation history sent to
the model is capped at the last 20 messages, both to keep each conversation's
usage predictable and stay comfortably inside free-tier limits.

## A known gap: abuse protection

This function has no rate limiting. On a low-traffic personal site that's
usually fine, but nothing stops someone from scripting requests against
`/api/chat` — on the free tier that mostly just means you could hit Google's
rate limit and the widget starts erroring for real visitors, rather than a
surprise bill. Before pointing real traffic at this long-term, consider
adding:

- Vercel's built-in [Attack Challenge Mode / Firewall rules](https://vercel.com/docs/security/attack-challenge-mode), or
- a proper rate limiter backed by Upstash Redis or similar (per-IP, e.g.
  10 messages/minute).

I didn't build a fake in-memory limiter into `api/chat.js` because it would
look like protection without actually being one — Vercel serverless
functions don't share memory across invocations, so it would reset
constantly and give false confidence.

## Switching providers later

If you outgrow the free tier, or want a provider that doesn't train on your
data, swapping is a one-file change — only `api/chat.js` needs to be
different; `index.html` and everything else stays the same, since the widget
just POSTs `{messages: [...]}` to `/api/chat` and reads back `{reply: "..."}`.

For Claude (Anthropic), the shape is: `POST https://api.anthropic.com/v1/messages`
with headers `x-api-key: <key>` and `anthropic-version: 2023-06-01`, a body of
`{model, max_tokens, system, messages: [{role, content}]}` (roles are
`"user"`/`"assistant"`, not `"user"`/`"model"`), and the reply text is at
`data.content[0].text`. See [docs.claude.com](https://docs.claude.com/en/docs/about-claude/models)
for current model IDs and pricing. Ask me and I can write that version of
`api/chat.js` for you directly.

## Security notes

- The API key only ever lives in the serverless function's environment —
  the browser never sees it. Don't move the `fetch` call to Gemini into
  client-side JavaScript.
- `/api/chat` only accepts same-origin requests from this deployment; there's
  no CORS header opening it up to other sites.
- Chat history is kept in the visitor's own browser (`localStorage`), not on
  a server — there's no shared database here.
