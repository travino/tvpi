/**
 * TVP + YouTube Live Stream Worker — no-KV edition
 * Paste-and-deploy: works in the Cloudflare dashboard with NO bindings.
 *
 * Routes:
 *   /  or  /playlist.m3u  → all channels combined
 *   /tvp1.m3u, /tvp2.m3u, /tvpinfo.m3u, /tvpsport.m3u, /tvpkultura.m3u,
 *   /tvpdokument.m3u, /tvpnauka.m3u, /tvprozrywka.m3u, /tvphistoria.m3u
 *   /wpolsce24.m3u, /republika.m3u  (via YouTube live — best-effort)
 *
 * Reliability model (no KV)
 * -------------------------
 *   State lives in caches.default (the edge cache). This is per-datacenter,
 *   not global, so each colo warms independently — fine for a low-traffic
 *   single playlist. Two layers of protection against TVP/YouTube hiccups:
 *
 *     1. "fresh" copy  — TTL 12 min, served straight to the player.
 *     2. "backup" copy — TTL 6 h, the last-known-good URL. If a live fetch
 *        fails, we fall back to this instead of returning a 503 (a 503 makes
 *        stream checkers mark the link dead).
 *
 *   The cron (every 10 min) refreshes both layers. Each upstream fetch has a
 *   timeout + retry. A failed refresh leaves the existing backup untouched.
 *
 *   SETUP (dashboard): just paste + Deploy, then add a Cron Trigger
 *   "*\/10 * * * *" under Settings → Triggers. No bindings, no KV.
 */

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

const TVP_LOGO = "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png";

const TVP_CHANNELS = [
  { id: "399697", slug: "tvp1",        name: "TVP 1 HD",     logo: TVP_LOGO, group: "Polska" },
  { id: "399698", slug: "tvp2",        name: "TVP 2 HD",     logo: TVP_LOGO, group: "Polska" },
  { id: "399699", slug: "tvpinfo",     name: "TVP Info",     logo: TVP_LOGO, group: "Polska" },
  { id: "399702", slug: "tvpsport",    name: "TVP Sport",    logo: TVP_LOGO, group: "Polska" },
  { id: "399700", slug: "tvpkultura",  name: "TVP Kultura",  logo: TVP_LOGO, group: "Polska" },
  { id: "399721", slug: "tvpdokument", name: "TVP Dokument", logo: TVP_LOGO, group: "Polska" },
  { id: "399722", slug: "tvpnauka",    name: "TVP Nauka",    logo: TVP_LOGO, group: "Polska" },
  { id: "399724", slug: "tvprozrywka", name: "TVP Rozrywka", logo: TVP_LOGO, group: "Polska" },
  { id: "399703", slug: "tvphistoria", name: "TVP Historia", logo: TVP_LOGO, group: "Polska" },
];

// YouTube-sourced channels. liveUrl is the channel's persistent /live page,
// resolved at refresh time to whatever broadcast is currently live.
const YOUTUBE_CHANNELS = [
  {
    slug:    "wpolsce24",
    name:    "wPolsce24",
    logo:    "https://wpolsce24.tv/favicon.ico",
    group:   "Polska",
    liveUrl: "https://www.youtube.com/@TelewizjawPolsce24/live",
  },
  {
    slug:    "republika",
    name:    "Telewizja Republika",
    logo:    "https://tvrepublika.pl/favicon.ico",
    group:   "Polska",
    liveUrl: "https://www.youtube.com/@Telewizja_Republika/live",
  },
];

const ALL_CHANNELS = [...TVP_CHANNELS, ...YOUTUBE_CHANNELS];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Two cache layers, keyed by a stable internal URL (caches.default needs a
// URL-shaped key). "fresh" is what we serve; "backup" is last-known-good.
const FRESH_PREFIX  = "https://tvpi-cache/fresh/";
const BACKUP_PREFIX = "https://tvpi-cache/backup/";

const FRESH_TTL_S   = 12 * 60;        // 12 min — under TVP's ~15 min token TTL
const BACKUP_TTL_S  = 6 * 60 * 60;    // 6 h — survives a prolonged upstream outage

const FETCH_TIMEOUT_MS = 8000;        // per upstream request
const RETRIES          = 2;           // extra attempts after the first

// ---------------------------------------------------------------------------
// Logging helper — structured JSON so logs are searchable in the dashboard
// ---------------------------------------------------------------------------

function log(level, fields) {
  const line = JSON.stringify({ level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Generic fetch helpers: timeout + retry
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Runs fn up to (RETRIES + 1) times. fn should throw or return falsy on
// failure. Returns the first truthy result, or null if all attempts fail.
async function withRetry(label, fn, attempts = RETRIES) {
  for (let i = 0; i <= attempts; i++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      log("warn", { msg: "attempt failed", label, attempt: i, error: String(e) });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TVP API
// ---------------------------------------------------------------------------

const TVP_API_URL =
  "https://vod.tvp.pl/api/products/{id}/videos/playlist?platform=BROWSER&videoType=LIVE";

const TVP_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://vod.tvp.pl/",
  Accept: "application/json, */*",
};

async function fetchTvpStreamUrl(channelId) {
  const res = await fetchWithTimeout(TVP_API_URL.replace("{id}", channelId), {
    headers: TVP_FETCH_HEADERS,
  });
  if (!res.ok) throw new Error(`TVP API HTTP ${res.status}`);
  const data = await res.json();
  return data?.sources?.HLS?.[0]?.src ?? null;
}

// ---------------------------------------------------------------------------
// YouTube — resolve a channel /live page to the current HLS manifest URL.
// Best-effort: YouTube frequently bot-walls datacenter IPs. On failure the
// channel falls back to its backup copy.
// ---------------------------------------------------------------------------

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function resolveLiveVideoId(liveUrl) {
  const res = await fetchWithTimeout(liveUrl, { headers: YT_HEADERS });
  if (!res.ok) throw new Error(`YouTube /live HTTP ${res.status}`);
  const html = await res.text();
  const patterns = [
    /"videoId":"([\w-]{11})"/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})">/,
    /watch\?v=([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchYouTubeStreamUrl(videoId) {
  const body = JSON.stringify({
    context: {
      client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en" },
    },
    videoId,
  });

  const res = await fetchWithTimeout(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": YT_HEADERS["User-Agent"],
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": "2.20240101.00.00",
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
  const data = await res.json();

  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return hlsUrl;

  const formats = data?.streamingData?.adaptiveFormats ?? [];
  const m3u8 = formats.find(
    (f) => f.url && (f.mimeType?.includes("x-mpegURL") || f.url.includes(".m3u8"))
  );
  return m3u8?.url ?? null;
}

async function fetchYouTubeChannelStreamUrl(liveUrl) {
  const videoId = await resolveLiveVideoId(liveUrl);
  if (!videoId) return null;
  return fetchYouTubeStreamUrl(videoId);
}

// ---------------------------------------------------------------------------
// Unified live resolver (with retry)
// ---------------------------------------------------------------------------

function resolveStreamUrl(ch) {
  if (ch.id) {
    return withRetry(`tvp:${ch.slug}`, () => fetchTvpStreamUrl(ch.id));
  }
  if (ch.liveUrl) {
    return withRetry(`yt:${ch.slug}`, () => fetchYouTubeChannelStreamUrl(ch.liveUrl));
  }
  return Promise.resolve(null);
}

// ---------------------------------------------------------------------------
// Edge-cache helpers (no binding required)
// ---------------------------------------------------------------------------

async function readCache(prefix, slug) {
  try {
    const hit = await caches.default.match(new Request(prefix + slug));
    if (!hit) return null;
    return (await hit.text()) || null;
  } catch (e) {
    log("warn", { msg: "cache read failed", prefix, slug, error: String(e) });
    return null;
  }
}

async function writeCache(prefix, slug, url, ttl) {
  try {
    await caches.default.put(
      new Request(prefix + slug),
      new Response(url, {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": `public, max-age=${ttl}`,
        },
      })
    );
  } catch (e) {
    log("warn", { msg: "cache write failed", prefix, slug, error: String(e) });
  }
}

// Store a freshly-resolved URL in both layers.
async function storeUrl(slug, url) {
  await Promise.allSettled([
    writeCache(FRESH_PREFIX, slug, url, FRESH_TTL_S),
    writeCache(BACKUP_PREFIX, slug, url, BACKUP_TTL_S),
  ]);
}

// ---------------------------------------------------------------------------
// Resolve for a request: fresh cache → live fetch → backup cache
// ---------------------------------------------------------------------------

async function getStreamForRequest(ch, ctx) {
  const fresh = await readCache(FRESH_PREFIX, ch.slug);
  if (fresh) return { ch, url: fresh, source: "fresh" };

  const live = await resolveStreamUrl(ch);
  if (live) {
    ctx.waitUntil(storeUrl(ch.slug, live));
    return { ch, url: live, source: "live" };
  }

  // Live fetch failed — serve last-known-good rather than dropping the channel.
  const backup = await readCache(BACKUP_PREFIX, ch.slug);
  if (backup) {
    log("warn", { msg: "serving backup — live fetch failed", slug: ch.slug });
    return { ch, url: backup, source: "backup" };
  }

  return { ch, url: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Cron — refresh every channel into both cache layers
// ---------------------------------------------------------------------------

async function refreshChannel(ch) {
  const url = await resolveStreamUrl(ch);
  if (url) {
    await storeUrl(ch.slug, url);
    log("info", { msg: "refreshed", slug: ch.slug });
    return true;
  }
  log("warn", { msg: "refresh failed — keeping backup", slug: ch.slug });
  return false;
}

async function refreshAllStreams() {
  const results = await Promise.allSettled(ALL_CHANNELS.map(refreshChannel));
  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;
  log("info", { msg: "cron refresh complete", ok, total: ALL_CHANNELS.length });
}

// ---------------------------------------------------------------------------
// M3U builder
// ---------------------------------------------------------------------------

function buildM3U(entries) {
  const lines = ["#EXTM3U"];
  for (const { ch, url } of entries) {
    const tvgId = ch.id ?? ch.slug;
    lines.push(
      `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group}",${ch.name}`,
      url
    );
  }
  return lines.join("\n") + "\n";
}

function notFoundBody() {
  return (
    "Not found.\n\nAvailable:\n" +
    ["/playlist.m3u", ...ALL_CHANNELS.map((c) => `/${c.slug}.m3u`)].join("\n") +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";

      let targets;
      if (path === "/" || path === "/playlist.m3u") {
        targets = ALL_CHANNELS;
      } else {
        const slug = path.replace(/^\//, "").replace(/\.m3u$/, "");
        const ch = ALL_CHANNELS.find((c) => c.slug === slug);
        if (!ch) {
          return new Response(notFoundBody(), {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }
        targets = [ch];
      }

      const results = await Promise.all(
        targets.map((ch) => getStreamForRequest(ch, ctx))
      );
      const valid = results.filter((r) => r.url);

      if (valid.length === 0) {
        return new Response(
          "No stream URLs available yet — please try again shortly.\n",
          { status: 503, headers: { "Retry-After": "60", "Content-Type": "text/plain" } }
        );
      }

      return new Response(buildM3U(valid), {
        headers: {
          "Content-Type": "application/x-mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          // Diagnostics: per-channel source (fresh | live | backup).
          "X-Stream-Source": valid.map((r) => `${r.ch.slug}=${r.source}`).join(","),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", { msg: "unhandled error in fetch", error: message });
      return new Response("Internal error.\n", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshAllStreams());
  },
};
