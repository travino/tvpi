/**
 * TVP Live Stream Worker (TypeScript)
 * Cloudflare Workers — free tier (100k req/day, 1k KV writes/day).
 *
 * Routes:
 *   /  | /playlist.m3u             → all channels combined
 *   /tvp1.m3u … /tvphistoria.m3u   → individual TVP channels
 *
 * Per-channel resolution: L1 per-colo Cache → L2 live TVP API →
 * L3a KV global last-known-good → L3b raw GitHub mirror → L3c R2 mirror.
 *
 * KV WRITE POLICY: KV is written ONLY by scheduled() (cron). The request path
 * never writes KV. Free tier = 1k writes/day; cron writes ≈ runs × channels,
 * so a ~30-min cron (48 × 8 = 384/day) stays well under the cap.
 *
 * R2 MIRROR (L3c): the cron also writes each channel's .m3u to the MIRROR
 * bucket. R2 survives the repo going private (unlike L3b raw GitHub) and is an
 * in-network read, so it sits as the final floor. It shares the cron's fate
 * with KV, so it stays AFTER the independently-refreshed (Actions) raw mirror.
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

interface Channel {
  id: string;
  slug: string;
  name: string;
  logo: string;
  group: string;
}

const TVP_LOGO = "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png";

const CHANNELS: readonly Channel[] = [
  { id: "399697", slug: "tvp1",        name: "TVP 1 HD",     logo: TVP_LOGO, group: "Polska" },
  { id: "399698", slug: "tvp2",        name: "TVP 2 HD",     logo: TVP_LOGO, group: "Polska" },
  { id: "399699", slug: "tvpinfo",     name: "TVP Info",     logo: TVP_LOGO, group: "Polska" },
  { id: "399702", slug: "tvpsport",    name: "TVP Sport",    logo: TVP_LOGO, group: "Polska" },
  { id: "399721", slug: "tvpdokument", name: "TVP Dokument", logo: TVP_LOGO, group: "Polska" },
  { id: "399722", slug: "tvpnauka",    name: "TVP Nauka",    logo: TVP_LOGO, group: "Polska" },
  { id: "399724", slug: "tvprozrywka", name: "TVP Rozrywka", logo: TVP_LOGO, group: "Polska" },
  { id: "399703", slug: "tvphistoria", name: "TVP Historia", logo: TVP_LOGO, group: "Polska" },
] as const;

const CHANNEL_BY_SLUG = new Map(CHANNELS.map((c) => [c.slug, c]));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_KEY_PREFIX = "https://tvpi-cache/stream/";
/** Keep BELOW TVP's token lifetime (~15–30 min). 600s = 10 min, safe margin. */
const CACHE_TTL = 600;
/** Bound every upstream fetch so a hung request fails over fast. */
const LIVE_TIMEOUT_MS = 7_000;
/** Raw committed playlist, kept ~fresh by GitHub Actions; served from GitHub's CDN. */
const RAW_BASE = "https://raw.githubusercontent.com/travino/tvpi/main/streams/";
/**
 * KV TTL for last-known-good. Kept SHORTER than the 30-min cron (900s = 15 min)
 * so a stale entry expires and resolution falls through to the raw GitHub
 * mirror (refreshed ~every 15 min by refresh.yml) instead of serving a
 * likely-expired TVP token out of KV.
 */
const KV_TTL = 900;
/** Attempts per live source fetch before failing over. */
const RETRY_ATTEMPTS = 2;

type Source = "cache" | "live" | "kv" | "raw" | "r2" | "none";

interface Resolved {
  url: string | null;
  source: Source;
}

// ---------------------------------------------------------------------------
// Structured logging + retry
// ---------------------------------------------------------------------------

type Level = "info" | "warn" | "error";

function log(level: Level, fields: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, ...fields });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

/**
 * Retry a source fetch. `fn` should THROW on transport failure (e.g. the
 * AbortError from AbortSignal.timeout) and return null when it reached the
 * upstream but found no URL. Returns the first truthy URL, or null when spent.
 */
async function withRetry(
  label: string,
  fn: () => Promise<string | null>,
  attempts = RETRY_ATTEMPTS,
): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      if (result) return result;
      log("warn", { msg: "attempt failed", label, error: "empty result", attempt });
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      log("warn", { msg: "attempt failed", label, error, attempt });
    }
  }
  return null;
}

const sourceLabel = (ch: Channel): string => `tvp:${ch.slug}`;

// ---------------------------------------------------------------------------
// L2 — TVP API
// ---------------------------------------------------------------------------

const TVP_API_URL =
  "https://vod.tvp.pl/api/products/{id}/videos/playlist?platform=BROWSER&videoType=LIVE";

const TVP_FETCH_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://vod.tvp.pl/",
  Accept: "application/json, */*",
};

interface TvpPlaylist {
  sources?: { HLS?: Array<{ src?: string }> };
}

async function fetchTvpStreamUrl(channelId: string): Promise<string | null> {
  // No try/catch: a transport error (e.g. AbortSignal.timeout firing) throws so
  // withRetry can log + retry it. A reachable-but-empty response returns null.
  const res = await fetch(TVP_API_URL.replace("{id}", channelId), {
    headers: TVP_FETCH_HEADERS,
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as TvpPlaylist;
  return data.sources?.HLS?.[0]?.src ?? null;
}

// ---------------------------------------------------------------------------
// L1 — Cache API (per-colo)
// ---------------------------------------------------------------------------

async function readFromCache(slug: string): Promise<string | null> {
  const cached = await caches.default.match(new Request(CACHE_KEY_PREFIX + slug));
  if (!cached) return null;
  const text = await cached.text();
  return text || null;
}

async function writeToCache(slug: string, url: string): Promise<void> {
  const response = new Response(url, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
  await caches.default.put(new Request(CACHE_KEY_PREFIX + slug), response);
}

// ---------------------------------------------------------------------------
// L3a — KV global last-known-good
//
// READ on the request path (cheap: 100k reads/day free).
// WRITE only from the cron (see refreshAllStreams).
// ---------------------------------------------------------------------------

async function readFromKV(env: Env, slug: string): Promise<string | null> {
  try {
    return (await env.LKG.get("lkg:" + slug)) || null;
  } catch {
    return null;
  }
}

async function writeToKV(env: Env, slug: string, url: string): Promise<void> {
  try {
    await env.LKG.put("lkg:" + slug, url, { expirationTtl: KV_TTL });
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// L3b — raw committed GitHub file (global, independent refresh path)
// ---------------------------------------------------------------------------

/** First http(s) URL line out of an .m3u body. */
const firstUrl = (m3u: string): string | null =>
  m3u.split("\n").map((l) => l.trim()).find((l) => l.startsWith("http")) ?? null;

async function fetchRawGithubUrl(slug: string): Promise<string | null> {
  try {
    const res = await fetch(RAW_BASE + slug + ".m3u", {
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return firstUrl(await res.text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// L3c — R2 mirror (global, survives the repo going private)
//
// READ on the request path. WRITE only from the cron (see refreshAllStreams).
// Keys mirror the raw layout (streams/<slug>.m3u) so the bucket doubles as a
// public mirror if a custom domain is later attached to it.
// ---------------------------------------------------------------------------

const R2_KEY = (slug: string): string => `streams/${slug}.m3u`;

async function readFromR2(env: Env, slug: string): Promise<string | null> {
  try {
    const obj = await env.MIRROR.get(R2_KEY(slug));
    if (!obj) return null;
    return firstUrl(await obj.text());
  } catch {
    return null;
  }
}

async function writeToR2(env: Env, ch: Channel, url: string): Promise<void> {
  try {
    await env.MIRROR.put(R2_KEY(ch.slug), buildM3U([{ ch, url }]), {
      httpMetadata: {
        contentType: "application/x-mpegurl",
        cacheControl: `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Resolve: L1 → L2 → L3a → L3b → L3c
//
// The request path writes only the per-colo cache (L1). KV and R2 are the
// cron's job.
// ---------------------------------------------------------------------------

async function getStreamUrl(ch: Channel, env: Env, ctx: ExecutionContext): Promise<Resolved> {
  const cached = await readFromCache(ch.slug);
  if (cached) return { url: cached, source: "cache" };

  const live = await withRetry(sourceLabel(ch), () => fetchTvpStreamUrl(ch.id));
  if (live) {
    ctx.waitUntil(writeToCache(ch.slug, live)); // cache only — no KV write here
    return { url: live, source: "live" };
  }

  const kv = await readFromKV(env, ch.slug);
  if (kv) return { url: kv, source: "kv" };

  const raw = await fetchRawGithubUrl(ch.slug);
  if (raw) return { url: raw, source: "raw" };

  const r2 = await readFromR2(env, ch.slug);
  if (r2) return { url: r2, source: "r2" };

  return { url: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Cron — the ONLY place KV and the R2 mirror are written
// ---------------------------------------------------------------------------

async function refreshAllStreams(env: Env): Promise<void> {
  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      const label = sourceLabel(ch);
      const url = await withRetry(label, () => fetchTvpStreamUrl(ch.id));
      if (url) {
        await writeToCache(ch.slug, url);
        await writeToKV(env, ch.slug, url);
        await writeToR2(env, ch, url);
        log("info", { msg: "cron cached", label, url: url.slice(0, 60) + "…" });
        return true;
      }
      log("warn", { msg: "cron fetch failed", label });
      return false;
    }),
  );
  const ok = results.filter(Boolean).length;
  log("info", { msg: "cron refresh complete", ok, total: CHANNELS.length });
}

// ---------------------------------------------------------------------------
// M3U builder
// ---------------------------------------------------------------------------

interface Entry {
  ch: Channel;
  url: string;
}

function buildM3U(entries: Entry[]): string {
  const lines = ["#EXTM3U"];
  for (const { ch, url } of entries) {
    lines.push(
      `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group}",${ch.name}`,
      url,
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";

      let targets: readonly Channel[];
      if (path === "/" || path === "/playlist.m3u") {
        targets = CHANNELS;
      } else {
        const slug = path.replace(/^\//, "").replace(/\.m3u$/, "");
        const ch = CHANNEL_BY_SLUG.get(slug);
        if (!ch) {
          return new Response(
            "Not found.\n\nAvailable:\n" +
              ["/playlist.m3u", ...CHANNELS.map((c) => `/${c.slug}.m3u`)].join("\n") +
              "\n",
            { status: 404, headers: { "Content-Type": "text/plain" } },
          );
        }
        targets = [ch];
      }

      const results = await Promise.all(
        targets.map(async (ch) => {
          const { url, source } = await getStreamUrl(ch, env, ctx);
          return { ch, url, source };
        }),
      );

      const valid: Entry[] = results.filter(
        (r): r is { ch: Channel; url: string; source: Source } => r.url !== null,
      );

      if (valid.length === 0) {
        log("error", {
          msg: "all sources exhausted",
          path,
          channels: results.map((r) => r.ch.slug).join(","),
        });
        return new Response("Could not fetch any stream URLs.\n", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const bySource = (s: Source): string =>
        results.filter((r) => r.source === s).map((r) => r.ch.slug).join(",") || "none";

      return new Response(buildM3U(valid), {
        headers: {
          "Content-Type": "application/x-mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-Source-Cache": bySource("cache"),
          "X-Source-Live": bySource("live"),
          "X-Source-KV": bySource("kv"),
          "X-Source-Raw": bySource("raw"),
          "X-Source-R2": bySource("r2"),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log("error", { msg: "unhandled error", error: message, path: new URL(request.url).pathname });
      return new Response("Internal server error.\n", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshAllStreams(env));
  },
} satisfies ExportedHandler<Env>;
