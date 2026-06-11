# Add a Channel (travino/tvpi)

You add a live channel to **travino/tvpi**, which serves Polish live TV as M3U playlists through two paths fed off the same channel list: a Cloudflare **Worker** (`worker/src/index.ts`, request-time resolution, recommended) and a **raw GitHub mirror** (`generate.py` → `streams/*.m3u`, committed every 15 min). A channel must be added to **both** files or the two paths disagree — the Worker would 404 a slug the mirror serves, or vice-versa.

The single most important habit: **keep `CHANNELS` (index.ts) and `TVP_CHANNELS`/static lists (generate.py) in lockstep** — same `slug`, `name`, `logo`, `group`, and `id`. Read both files before editing.

## How the project fits together

```
.
├── worker/src/index.ts        # Worker: CHANNELS[] + per-request L1→L2→L3a→L3b resolution; auto-deploys on push to worker/**
├── generate.py                # TVP_CHANNELS[]; pure-stdlib; writes streams/*.m3u (cron via refresh.yml)
├── streams/<slug>.m3u         # committed snapshots (raw mirror); picked up by the git add streams/ glob automatically
├── .github/workflows/refresh.yml  # */15 cron → python3 generate.py → commit streams/
└── .github/workflows/deploy.yml   # push to worker/** → wrangler deploy
```

Current channels (TVP, all via the API): `tvp1` 399697, `tvp2` 399698, `tvpinfo` 399699, `tvpsport` 399702, `tvpdokument` 399721, `tvpnauka` 399722, `tvprozrywka` 399724, `tvphistoria` 399703. All share one logo constant (`TVP_LOGO` in the worker; the same URL inline in `generate.py`) and `group: "Polska"`.

The `Channel` shape (worker) is `{ id, slug, name, logo, group }`; the generator dict mirrors it. `buildM3U` uses `ch.id` as `tvg-id`; `generate.py`'s `extinf()` falls back to `slug` when a dict has no `id`.

## Step 0: Pick the source type

This decides everything. In order of preference (cleanest drop-in first):

1. **TVP channel** — a `vod.tvp.pl/live,...` channel. Resolves through the existing TVP API path with **zero new code** — just two list entries. Always prefer this for TVP channels.
2. **Direct HLS manifest** — a stable `.m3u8` URL (e.g. OnNetwork `str.onnetwork.tv/...`). Strongly preferred for non-TVP sources. Needs a tiny one-time `src` extension to both files (below), then it's static — no token refresh, no API.
3. **YouTube live** — a `/@Handle/live` channel. Heaviest: requires re-introducing `yt-dlp` + cookies into `refresh.yml` (stripped from the current repo) and is unreliable from datacenter IPs. Only if 1 and 2 are impossible.

Avoid player-wrapped / token-gated embeds (e.g. IPLA/Polsat): they need JS execution and signed tokens and don't drop in.

## TVP channel (preferred)

### 1. Get the product id

The id is the trailing number in the live URL: `https://vod.tvp.pl/live,1/{name},{id}`. Open the channel's live page on vod.tvp.pl and read it off, or search the site.

### 2. Verify it streams before touching code

```bash
curl -s "https://vod.tvp.pl/api/products/{ID}/videos/playlist?platform=BROWSER&videoType=LIVE" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -H "Referer: https://vod.tvp.pl/" -H "Accept: application/json, */*" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('sources',{}).get('HLS',[{}])[0].get('src'))"
```

A real `https://…/token/…` URL = good. `None` / 404 = wrong id or not a live product; fix before proceeding.

### 3. Add to the Worker (`worker/src/index.ts`)

Append to `CHANNELS`, matching the existing alignment:

```ts
  { id: "{ID}", slug: "{slug}", name: "{Name}", logo: TVP_LOGO, group: "Polska" },
```

### 4. Add to the generator (`generate.py`)

Append the mirror entry to `TVP_CHANNELS` (same values; logo URL written inline as the others are):

```python
    {
        "id":    "{ID}",
        "slug":  "{slug}",
        "name":  "{Name}",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
```

Pick a short lowercase `slug` (it's the URL: `/{slug}.m3u`); keep it consistent across both files. Then go to [Verify](#verify).

## Direct HLS manifest (preferred for non-TVP)

A static `.m3u8` that plays directly. Confirm it first:

```bash
curl -s "{HLS_URL}" | head -5      # expect #EXTM3U / #EXT-X-… ; or check it 200s and is a manifest
```

These don't need the API/token machinery, so add a static-URL path **once** and reuse it for any future direct channel.

### Worker (`worker/src/index.ts`)

Add an optional `src` to the interface and short-circuit resolution when present:

```ts
interface Channel { id: string; slug: string; name: string; logo: string; group: string; src?: string; }
```

Near the top of `getStreamUrl`, before the cache lookup:

```ts
  if (ch.src) return { url: ch.src, source: "live" };   // static manifest — no API/token needed
```

Then the channel entry carries its URL:

```ts
  { id: "{slug}", slug: "{slug}", name: "{Name}", logo: "{LOGO_URL}", group: "{Group}", src: "{HLS_URL}" },
```

(The cron's `refreshAllStreams` calls `fetchTvpStreamUrl(ch.id)`, which won't resolve a static channel — that's fine; it just logs a miss and the static `src` always serves on the request path. Optionally guard it with `if (!ch.src)` if the log noise bothers you.)

### Generator (`generate.py`)

Add a separate static list and emit it without an API call. After `TVP_CHANNELS`:

```python
STATIC_CHANNELS = [
    {
        "id":    "{slug}",          # tvg-id; extinf() also falls back to slug
        "slug":  "{slug}",
        "name":  "{Name}",
        "logo":  "{LOGO_URL}",
        "group": "{Group}",
        "url":   "{HLS_URL}",
    },
]
```

In `main()`, after the TVP loop and before writing the combined playlist, emit each static channel directly:

```python
    for ch in STATIC_CHANNELS:
        filename = f"{STREAMS_DIR}/{ch['slug']}.m3u"
        all_ok_entries.append((ch, ch["url"]))
        write_m3u(filename, [(ch, ch["url"])])
```

Use an `id` value (the slug is fine) so the Worker's `buildM3U` has a `tvg-id`. Then [Verify](#verify).

## YouTube live (heaviest — only if nothing else works)

Not wired in the current repo; this re-introduces machinery that was removed. Be explicit with the user that it's the brittle path.

- Use the persistent `https://www.youtube.com/@{Handle}/live` URL (resolves whatever broadcast is currently live), not a fixed video id.
- `generate.py`: add a resolver shelling out to `yt-dlp -g --no-warnings "{LIVE_URL}"` (apply `--cookies cookies.txt` only if present), with retry/backoff that's 429-aware. Append results like a static channel.
- `refresh.yml`: add `pip install "yt-dlp[default]"` (and `denoland/setup-deno@v2` if the extractor needs it); add a `YT_COOKIES` secret → `cookies.txt` step to get past the bot-wall. Datacenter IPs hit bot-detection reliably, so this path needs cookies and is still best-effort.
- The Worker's live YouTube resolution is unreliable; treat the Actions/yt-dlp path as the source of truth and let the Worker fall back to the raw mirror.

Given the effort and fragility, prefer a direct HLS manifest for the same channel if one exists (e.g. an OnNetwork URL).

## Verify

```bash
# 1) Generator emits the new channel with a real URL (no placeholder stub):
python3 generate.py
cat streams/{slug}.m3u            # → #EXTM3U + #EXTINF + an http(s) URL

# 2) Worker still type-checks (you edited index.ts):
cd worker && npm install && npx wrangler types && npx tsc --noEmit && cd ..

# 3) After worker/** is pushed and Deploy Worker lands, the slug resolves:
curl -sI https://tvpi.travny.workers.dev/{slug}.m3u | grep -i 'http/\|x-source'
#   TVP channel → slug in X-Source-Live ; static channel → also "live" (short-circuited)
```

Good = generator writes a real URL, worker type-checks, and `/{slug}.m3u` returns 200 served from `live`/`cache`.

## Commit & ship

- Push the `index.ts` change under `worker/**` → `deploy.yml` auto-deploys the Worker.
- `streams/{slug}.m3u` is regenerated on the next `*/15` cron; to publish immediately dispatch `refresh.yml` from the Actions tab. The `git add streams/` glob commits the new file with no workflow change.
- Optionally add a row to the README channel table (logo + Worker/raw links + a status badge mirroring the existing rows).

## Guardrails

- **Both files, every time.** A channel in only one path is the most common mistake — the Worker 404s a slug the mirror has, or the mirror lacks a slug the Worker serves.
- **Keep slug/name/id/group identical** across `index.ts` and `generate.py`.
- **Don't route a non-TVP channel through the TVP API path** — it has no product id; use the static `src`/`url` mechanism.
- **Don't add KV writes** or other request-path side effects while editing the Worker — KV is cron-only by design.
- **Prefer direct HLS over player-wrapped/token-gated sources.** If a source needs JS execution or signed short-lived tokens you can't fetch server-side, stop and flag it rather than half-adding it.
- If you extended the `Channel` interface for `src`, that's a one-time change — reuse it for the next direct channel instead of re-adding it.
