/**
 * TVP Live Stream Worker
 * Deploy to Cloudflare Workers (free tier: 100k req/day)
 *
 * Routes:
 *   /tvp.m3u         → all channels combined
 *   /tvp1.m3u        → TVP 1 HD
 *   /tvp2.m3u        → TVP 2 HD
 *   /tvpinfo.m3u     → TVP Info
 *   /tvpsport.m3u    → TVP Sport
 *   /tvpkultura.m3u  → TVP Kultura
 *   /tvpdokument.m3u → TVP Dokument
 *   /tvpnauka.m3u    → TVP Nauka
 *   /tvprozrywka.m3u → TVP Rozrywka
 *   /tvphistoria.m3u → TVP Historia

 * Caching strategy:
 *   - scheduled() (every 30 min) pre-fetches all stream URLs from the TVP API
 *     and stores each one in the Cloudflare Cache API under a stable internal
 *     key: https://tvpi-cache/stream/<slug>  (TTL 1800 s)
 *   - fetch() reads from cache first; falls back to a live TVP API call only
 *     on a cold start or after a failed cron run.
 */
const CHANNELS = [
  {
    id:    "399697",
    slug:  "tvp1",
    name:  "TVP 1 HD",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399698",
    slug:  "tvp2",
    name:  "TVP 2 HD",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399699",
    slug:  "tvpinfo",
    name:  "TVP Info",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399702",
    slug:  "tvpsport",
    name:  "TVP Sport",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399700",
    slug:  "tvpkultura",
    name:  "TVP Kultura",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399721",
    slug:  "tvpdokument",
    name:  "TVP Dokument",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399722",
    slug:  "tvpnauka",
    name:  "TVP Nauka",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399724",
    slug:  "tvprozrywka",
    name:  "TVP Rozrywka",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
  {
    id:    "399703",
    slug:  "tvphistoria",
    name:  "TVP Historia",
    logo:  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
    group: "Polska",
  },
];

// Stable internal cache key prefix — not a real URL, just a unique namespace.
const CACHE_KEY_PREFIX = "https://tvpi-cache/stream/";

// How long cached stream URLs are considered fresh (matches cron interval).
const CACHE_TTL = 1800; // seconds

const API_URL =
  "https://vod.tvp.pl/api/products/{id}/videos/playlist?platform=BROWSER&videoType=LIVE";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://vod.tvp.pl/",
  Accept: "application/json, */*",
};

// ---------------------------------------------------------------------------
// TVP API
// ---------------------------------------------------------------------------

async function fetchStreamUrlFromApi(channelId) {
  try {
    const res = await fetch(API_URL.replace("{id}", channelId), {
      headers: FETCH_HEADERS,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.sources?.HLS?.[0]?.src ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache helpers  (Cloudflare Cache API — keyed on Request URL strings)
// ---------------------------------------------------------------------------

async function readFromCache(slug) {
  const cache = caches.default;
  const cached = await cache.match(new Request(CACHE_KEY_PREFIX + slug));
  if (!cached) return null;
  const text = await cached.text();
  return text || null;
}

async function writeToCache(slug, url) {
  const cache = caches.default;
  const response = new Response(url, {
    headers: {
      "Content-Type": "text/plain",
      // Workers Cache API respects Cache-Control for TTL.
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
  await cache.put(new Request(CACHE_KEY_PREFIX + slug), response);
}

// ---------------------------------------------------------------------------
// Resolve a stream URL: cache → live fallback
// ---------------------------------------------------------------------------

async function getStreamUrl(ch) {
  // 1. Try cache first.
  const cached = await readFromCache(ch.slug);
  if (cached) return { url: cached, fromCache: true };

  // 2. Cache miss — hit the TVP API directly.
  const url = await fetchStreamUrlFromApi(ch.id);
  if (url) {
    // Opportunistically populate the cache so the next request is fast.
    await writeToCache(ch.slug, url);
  }
  return { url, fromCache: false };
}

// ---------------------------------------------------------------------------
// Pre-cache all channels (called by the cron trigger)
// ---------------------------------------------------------------------------

async function refreshAllStreams() {
  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      const url = await fetchStreamUrlFromApi(ch.id);
      if (url) {
        await writeToCache(ch.slug, url);
        console.log(`[cron] cached ${ch.slug}: ${url.slice(0, 60)}…`);
        return true;
      } else {
        console.warn(`[cron] failed to fetch ${ch.slug} (id=${ch.id})`);
        return false;
      }
    })
  );

  const ok = results.filter(Boolean).length;
  console.log(`[cron] refreshed ${ok}/${CHANNELS.length} streams`);
}

// ---------------------------------------------------------------------------
// M3U builder
// ---------------------------------------------------------------------------

function buildM3U(entries) {
  const lines = ["#EXTM3U"];
  for (const { ch, url } of entries) {
    lines.push(
      `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group}",${ch.name}`,
      url
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  // HTTP handler
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";

    // Determine which channels to serve.
    let targets;
    if (path === "/" || path === "/tvp.m3u") {
      targets = CHANNELS;
    } else {
      const slug = path.replace(/^\//, "").replace(/\.m3u$/, "");
      const ch = CHANNELS.find((c) => c.slug === slug);
      if (!ch) {
        return new Response(
          "Not found.\n\nAvailable:\n" +
            ["/tvp.m3u", ...CHANNELS.map((c) => `/${c.slug}.m3u`)].join("\n") +
            "\n",
          { status: 404 }
        );
      }
      targets = [ch];
    }

    // Resolve URLs (cache-first, live fallback) in parallel.
    const results = await Promise.all(
      targets.map(async (ch) => {
        const { url, fromCache } = await getStreamUrl(ch);
        return { ch, url, fromCache };
      })
    );

    const valid = results.filter((r) => r.url !== null);

    if (valid.length === 0) {
      return new Response("Could not fetch any stream URLs from TVP API.\n", {
        status: 503,
      });
    }

    // Report cache hit/miss in a header for easy debugging.
    const hitSlugs  = valid.filter((r) =>  r.fromCache).map((r) => r.ch.slug);
    const missSlugs = valid.filter((r) => !r.fromCache).map((r) => r.ch.slug);

    return new Response(buildM3U(valid), {
      headers: {
        "Content-Type": "application/x-mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Cache-Hit":  hitSlugs.join(",")  || "none",
        "X-Cache-Miss": missSlugs.join(",") || "none",
      },
    });
  },

  // Cron handler — runs every 30 minutes, pre-warms the cache.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshAllStreams());
  },
};
