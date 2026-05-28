/**
 * TVP + YouTube Live Stream Worker
 * Deploy to Cloudflare Workers (free tier: 100k req/day)
 *
 * Routes:
 *   /playlist.m3u    → all channels combined
 *   /tvp1.m3u … /tvphistoria.m3u → individual TVP channels
 *   /wpolsce24.m3u   → wPolsce24 (via YouTube live)
 *   /republika.m3u   → Telewizja Republika (via YouTube live)
 *
 * Resolution strategy (per channel):
 *   L1  Cache API           — fast, but PER-COLO (cron only warms one colo)
 *   L2  live source fetch   — TVP API / YouTube, now bounded by LIVE_TIMEOUT_MS
 *   L3a KV (env.LKG)        — GLOBAL last-known-good, written on every success
 *   L3b raw GitHub file     — committed playlist, refreshed ~15 min by Actions
 *
 * Why L3 exists: caches.default is per-data-center. The scheduled() cron warms
 * the cache in ONE colo, so a viewer routed through a cold colo (e.g. KUL) hits
 * the live path — and if vod.tvp.pl is slow/blocked from that egress, the old
 * code returned 503 after a ~24s hang. The durable fallbacks below remove that.
 *
 * KV is OPTIONAL: bind a KV namespace as `LKG` and it's used automatically.
 * Without it, L3b (raw GitHub) still provides a global fallback.
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

const CACHE_KEY_PREFIX = "https://tvpi-cache/stream/";
// Keep BELOW TVP's token lifetime (~15–30 min). 600s = 10 min, safe margin.
const CACHE_TTL = 600; // seconds

// Bound every upstream fetch so a hung request fails over to a fallback fast
// instead of holding the whole response open (the 24s hang seen in the logs).
const LIVE_TIMEOUT_MS = 7000;

// Raw committed playlist — kept ~fresh by GitHub Actions every 15 min, served
// from GitHub's CDN (independent of Cloudflare egress, so it can work even when
// vod.tvp.pl is unreachable from a given colo).
const RAW_BASE = "https://raw.githubusercontent.com/travino/tvpi/main/streams/";

// KV time-to-live for last-known-good entries. Refreshed on every successful
// resolve, so in normal traffic this is effectively always fresh. Generous so
// it survives a short upstream outage.
const KV_TTL = 1800; // seconds (30 min)

// Number of attempts per live source fetch before giving up to a fallback.
// Each failed attempt emits a structured "attempt failed" log (see withRetry),
// matching the {label, error, attempt} shape used by the deployed worker.
const RETRY_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Structured logging + retry
// ---------------------------------------------------------------------------

// Emit a single structured object so Cloudflare surfaces the fields directly
// (level / msg / label / error / attempt) rather than a flat string.
function log(level, fields) {
  const entry = { level, ...fields };
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

// Retry a source fetch. `fn` should THROW on transport failure (e.g. the
// AbortError raised by AbortSignal.timeout) and return null when it reached
// the upstream but found no URL. Both cases are logged per attempt; the final
// return is the first truthy URL, or null once attempts are exhausted.
async function withRetry(label, fn, attempts = RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      if (result) return result;
      log("warn", { msg: "attempt failed", label, error: "empty result", attempt });
    } catch (e) {
      const error = e?.name ? `${e.name}: ${e.message}` : String(e);
      log("warn", { msg: "attempt failed", label, error, attempt });
    }
  }
  return null;
}

// Stable label for a channel's source, e.g. "tvp:tvp2" / "yt:republika".
function sourceLabel(ch) {
  return `${ch.id ? "tvp" : "yt"}:${ch.slug}`;
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
  // No try/catch here: a transport error (e.g. AbortSignal.timeout firing)
  // is allowed to throw so withRetry can log it and retry. A reachable-but-
  // empty response returns null.
  const res = await fetch(TVP_API_URL.replace("{id}", channelId), {
    headers: TVP_FETCH_HEADERS,
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.sources?.HLS?.[0]?.src ?? null;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function resolveLiveVideoId(liveUrl) {
  const res = await fetch(liveUrl, {
    headers: YT_HEADERS,
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
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
  const res = await fetch(
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
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    }
  );
  if (!res.ok) return null;
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
// Unified live resolver (L2)
// ---------------------------------------------------------------------------

async function fetchStreamUrlFromSource(ch) {
  if (ch.id) return fetchTvpStreamUrl(ch.id);
  if (ch.liveUrl) return fetchYouTubeChannelStreamUrl(ch.liveUrl);
  return null;
}

// ---------------------------------------------------------------------------
// L1 — Cache API (per-colo)
// ---------------------------------------------------------------------------

async function readFromCache(slug) {
  const cached = await caches.default.match(new Request(CACHE_KEY_PREFIX + slug));
  if (!cached) return null;
  const text = await cached.text();
  return text || null;
}

async function writeToCache(slug, url) {
  const response = new Response(url, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
  await caches.default.put(new Request(CACHE_KEY_PREFIX + slug), response);
}

// ---------------------------------------------------------------------------
// L3a — KV global last-known-good (optional; only if env.LKG is bound)
// ---------------------------------------------------------------------------

async function readFromKV(env, slug) {
  if (!env?.LKG) return null;
  try {
    return (await env.LKG.get("lkg:" + slug)) || null;
  } catch {
    return null;
  }
}

async function writeToKV(env, slug, url) {
  if (!env?.LKG) return;
  try {
    await env.LKG.put("lkg:" + slug, url, { expirationTtl: KV_TTL });
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// L3b — raw committed GitHub file (global, independent refresh path)
// ---------------------------------------------------------------------------

async function fetchRawGithubUrl(slug) {
  try {
    const res = await fetch(RAW_BASE + slug + ".m3u", {
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("http")) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolve: L1 → L2 → L3a → L3b
// ---------------------------------------------------------------------------

async function getStreamUrl(ch, env) {
  // L1: warm per-colo cache
  const cached = await readFromCache(ch.slug);
  if (cached) return { url: cached, source: "cache" };

  // L2: live source (bounded per attempt, retried)
  const live = await withRetry(sourceLabel(ch), () => fetchStreamUrlFromSource(ch));
  if (live) {
    await writeToCache(ch.slug, live);
    await writeToKV(env, ch.slug, live);
    return { url: live, source: "live" };
  }

  // L3a: global last-known-good in KV
  const kv = await readFromKV(env, ch.slug);
  if (kv) return { url: kv, source: "kv" };

  // L3b: committed raw file (refreshed by Actions from non-CF IPs)
  const raw = await fetchRawGithubUrl(ch.slug);
  if (raw) return { url: raw, source: "raw" };

  return { url: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Pre-cache all channels (cron) — also seeds KV globally
// ---------------------------------------------------------------------------

async function refreshAllStreams(env) {
  const results = await Promise.all(
    ALL_CHANNELS.map(async (ch) => {
      const label = sourceLabel(ch);
      const url = await withRetry(label, () => fetchStreamUrlFromSource(ch));
      if (url) {
        await writeToCache(ch.slug, url);
        await writeToKV(env, ch.slug, url);
        log("info", { msg: "cron cached", label, url: url.slice(0, 60) + "…" });
        return true;
      }
      log("warn", { msg: "cron fetch failed", label });
      return false;
    })
  );
  const ok = results.filter(Boolean).length;
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

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";

    let targets;
    if (path === "/" || path === "/playlist.m3u") {
      targets = ALL_CHANNELS;
    } else {
      const slug = path.replace(/^\//, "").replace(/\.m3u$/, "");
      const ch = ALL_CHANNELS.find((c) => c.slug === slug);
      if (!ch) {
        return new Response(
          "Not found.\n\nAvailable:\n" +
            ["/playlist.m3u", ...ALL_CHANNELS.map((c) => `/${c.slug}.m3u`)].join("\n") +
            "\n",
          { status: 404 }
        );
      }
      targets = [ch];
    }

    const results = await Promise.all(
      targets.map(async (ch) => {
        const { url, source } = await getStreamUrl(ch, env);
        return { ch, url, source };
      })
    );

    const valid = results.filter((r) => r.url !== null);

    if (valid.length === 0) {
      log("error", {
        msg: "all sources exhausted",
        path,
        channels: results.map((r) => r.ch.slug).join(","),
      });
      return new Response("Could not fetch any stream URLs.\n", { status: 503 });
    }

    const bySource = (s) => valid.filter((r) => r.source === s).map((r) => r.ch.slug);

    return new Response(buildM3U(valid), {
      headers: {
        "Content-Type": "application/x-mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "X-Source-Cache": bySource("cache").join(",") || "none",
        "X-Source-Live":  bySource("live").join(",")  || "none",
        "X-Source-KV":    bySource("kv").join(",")    || "none",
        "X-Source-Raw":   bySource("raw").join(",")   || "none",
      },
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshAllStreams(env));
  },
};
