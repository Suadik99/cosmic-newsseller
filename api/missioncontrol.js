// api/mission-control.js
//
// Auto-updating data for the "Mission Control" section of index.html.
// This serverless function pulls fresh numbers from several real, free
// space-data APIs and hands them back as one JSON object for the page's
// JavaScript to display. No API keys are exposed to the browser -- the
// NASA key (if set) is only ever used from here, server-side.
//
// Sources:
//   - CelesTrak            (active satellite count)               -- no key needed
//   - NASA NeoWs            (near-Earth objects tracked today)     -- needs NASA_API_KEY
//   - NASA APOD              (Astronomy Picture of the Day)        -- needs NASA_API_KEY
//   - The Space Devs         (SpaceX launches, upcoming + recent)  -- no key needed
//   - Spaceflight News API   (space news headlines)                -- no key needed
//
// Get a free NASA key (instant, no approval wait) at https://api.nasa.gov
// and set it as the NASA_API_KEY environment variable in Vercel. Without
// it, the satellites/launches/news sections still work -- only the
// near-Earth-object count and the picture of the day will be skipped.
//
// This response is cached at Vercel's edge for 30 minutes (see the
// Cache-Control header at the bottom) -- that's what makes this section
// "auto-update" without hammering these free APIs on every single visitor.

const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

// Small helper: fetch with a timeout, so one slow upstream API can't hang
// the whole response. Returns null on any failure instead of throwing --
// each section below is independent, so one missing source never breaks
// the others.
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
  const data = await safeFetchJson(
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
    15000 // this catalog is large, give it more time
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
  const hazardous = all.filter((o) => o && o.is_potentially_hazardous_asteroid).length;
  return { count: all.length, hazardous };
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
    explanation: String(data.explanation || '').slice(0, 260),
    credit: data.copyright ? String(data.copyright).trim() : 'NASA',
    date: data.date || '',
  };
}

function shortLaunchName(name) {
  if (!name) return 'Unnamed launch';
  // Space Devs names often look like "Falcon 9 Block 5 | Starlink 10-49" --
  // keep it, it's already readable and matches the site's existing style.
  return name;
}

async function getLaunches() {
  const [upcoming, previous] = await Promise.all([
    safeFetchJson('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?lsp__name=SpaceX&limit=3&ordering=net'),
    safeFetchJson('https://ll.thespacedevs.com/2.2.0/launch/previous/?lsp__name=SpaceX&limit=2&ordering=-net'),
  ]);
  const up = (upcoming && Array.isArray(upcoming.results)) ? upcoming.results : [];
  const prev = (previous && Array.isArray(previous.results)) ? previous.results : [];
  if (up.length === 0 && prev.length === 0) return null;

  return {
    upcoming: up.map((l) => ({
      name: shortLaunchName(l.name),
      net: l.net || null,
      pad: (l.pad && l.pad.location && l.pad.location.name) || '',
    })),
    previous: prev.map((l) => ({
      name: shortLaunchName(l.name),
      net: l.net || null,
      success: l.status && (l.status.abbrev === 'Success' || l.status.id === 3),
    })),
  };
}

async function getNews() {
  const data = await safeFetchJson('https://api.spaceflightnewsapi.net/v4/articles/?limit=6&ordering=-published_at');
  if (!data || !Array.isArray(data.results)) return null;
  return data.results.map((a) => ({
    title: a.title,
    url: a.url,
    site: a.news_site || 'Space news',
    publishedAt: a.published_at || null,
  }));
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');

  const [satellites, neo, apod, launches, news] = await Promise.all([
    getSatellites(),
    getNeo(),
    getApod(),
    getLaunches(),
    getNews(),
  ]);

  // Cache this response at Vercel's edge for 30 minutes, and allow serving
  // a slightly-stale copy for up to an hour while a fresh one is fetched
  // in the background. This is what makes the section "auto-update"
  // periodically without every visitor triggering five API calls.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    satellites,
    neo,
    apod,
    launches,
    news,
  });
};
