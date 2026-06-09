---
name: tvpi-channel-fix
description: Diagnose and fix a dead, stale, or dropping channel in the travino/tvpi IPTV project — read the Worker's X-Source-* headers to localize the failure layer, confirm the cause against the live TVP API, make a minimal edit to worker/src/index.ts and/or generate.py, and verify. Use whenever a channel is offline/down/dropping, a status badge is red, a stream "works then dies then recovers", the raw mirror is stale, or someone says "tvpi is broken", "channel X stopped", "fix the stream".
---

# TVP Channel Fix (travino/tvpi)

> **In claude.ai chat.** The repo isn't checked out on disk here, and `gh`/`wrangler` aren't authenticated. Two ways to work:
> - **Read/write via the github connector** (`github:get_file_contents`, `github:create_or_update_file`, `github:push_files`) — preferred for small, targeted edits. Edit `worker/src/index.ts` and `generate.py` together in one `push_files` call so the two stay in lockstep (see the `github-ops` skill).
> - **Or `git clone` in the bash sandbox** when you need to actually run the local checks below (`npx wrangler types && npx tsc --noEmit`, `python3 generate.py`). The sandbox can run `git`/`npm`/`python3`/`curl` but starts empty and **has no GitHub auth** — so the clone only works while the repo is **public** (`git clone https://github.com/travino/tvpi`). **If the repo is private**, the connector still works fine; just stay connector-only — read files via `github:*`, push, and verify by watching the Actions run instead of running the checks locally. Don't paste a token into the chat to force a clone.
> Replace every `gh ...` call (workflow dispatch, API reads, run logs) with the github connector: `github:list_issues`, `github:list_commits`, `github:get_latest_release`, and dispatch/run-log reads through the connector — `gh` has no token in chat. After writing, verify by re-reading the file (returned commit SHA) and checking the Actions run, then report the SHA/run conclusion, not just "done."


A channel stopped playing. The job is to find **which resolution layer broke**, fix the one real cause, and verify — not to blindly regenerate or commit placeholders. Most "outages" are either an expired token on the raw mirror (self-healing, not a bug) or the live TVP fetch failing because the API shape or a channel ID changed.

## Architecture in one breath

Two delivery paths, both fed from the same TVP API:

- **Worker** (`https://tvpi.travny.workers.dev`, source `worker/src/index.ts`) — resolves per request: **L1** per-colo Cache → **L2** live TVP API → **L3a** KV last-known-good → **L3b** raw GitHub mirror. KV is written **only** by the cron (`scheduled()`), never on the request path.
- **Raw mirror** (`https://raw.githubusercontent.com/travino/tvpi/main/streams/{slug}.m3u`) — static snapshots committed every 15 min by `generate.py` via `.github/workflows/refresh.yml`.

Channels (keep `CHANNELS` in `index.ts` and `TVP_CHANNELS` in `generate.py` identical): `tvp1` 399697, `tvp2` 399698, `tvpinfo` 399699, `tvpsport` 399702, `tvpdokument` 399721, `tvpnauka` 399722, `tvprozrywka` 399724, `tvphistoria` 399703.

## Input

A channel name or slug (`tvpsport`). If none given, check all eight — the header sweep in Step 1 shows every channel's serving layer at once.

## Workflow

### 1. Localize the failure with X-Source headers

The Worker tags every response with which layer served each channel. This is the whole diagnosis — read it first.

```bash
# One channel:
curl -sI https://tvpi.travny.workers.dev/tvpsport.m3u | grep -i x-source

# All channels at once (each slug appears in exactly one X-Source-* list):
curl -sI https://tvpi.travny.workers.dev/playlist.m3u | grep -i x-source
```

Interpretation:

| Slug appears in… | Meaning | Action |
|---|---|---|
| `X-Source-Live` or `X-Source-Cache` | Worker healthy, **L2 live fetch works** | If a player still fails → downstream (geo-block / player / token raced). **Not a repo bug** — see Notes. |
| `X-Source-KV` or `X-Source-Raw` | **L2 live fetch is FAILING for this channel** | This is the real signal. Go to Step 2 to find why. |
| nothing / HTTP 503 | All layers exhausted | If it's **all** channels → suspect cron-stalled + API-wide break/outage. If **one** → discontinued ID. Step 2. |

Also glance at the raw mirror's freshness — a stale commit across *all* files points at the cron, not the code. Use authenticated `gh` (the unauthenticated `api.github.com` is rate-limited from cloud/CI IPs and returns a `message` dict instead of commits):

```bash
# Last commit that touched streams/ (UTC); compare to `date -u`:
gh api "repos/travino/tvpi/commits?path=streams&per_page=1" -q '.[0].commit.committer.date'
```

### 2. Confirm the cause against the live TVP API

For any channel that fell through to KV/Raw/none, hit the API exactly as the code does (id from the table above):

```bash
curl -s "https://vod.tvp.pl/api/products/399702/videos/playlist?platform=BROWSER&videoType=LIVE" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -H "Referer: https://vod.tvp.pl/" \
  -H "Accept: application/json, */*" | python3 -m json.tool | head -40
```

Read the result:

- **200 with `.sources.HLS[0].src` present** → API is fine; the code's JSON path no longer matches → **shape change** (Fix A).
- **200 but `.sources` has no `HLS` / different shape** → dump keys with `... | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sources',{}).keys())"` → shape change (Fix A).
- **404 / error / empty body** → the channel **ID changed or was discontinued** (Fix B).
- **All channels error identically** → TVP-side outage or API-wide change; if the latter, Fix A once fixes everyone.

### 3. Fix (minimal, and mirror it across both files)

The Worker and the generator each independently call the same API and dig the same path. A real fix almost always edits **both** `worker/src/index.ts` and `generate.py`, or they drift.

**Fix A — JSON path moved.** Update the extraction in both:
- `index.ts` → `fetchTvpStreamUrl`: `data.sources?.HLS?.[0]?.src` and the `TvpPlaylist` interface.
- `generate.py` → `get_tvp_stream_url`: `data.get("sources", {}).get("HLS", [])[0]["src"]`.

Change only the path to match the new shape. Leave timeouts, headers, retry, and fallback logic alone.

**Fix B — channel ID changed.** Get the new id from the live VOD page (pattern `vod.tvp.pl/live,1/{name},{id}` — the trailing number is the id), then update the entry in `CHANNELS` (`index.ts`) **and** `TVP_CHANNELS` (`generate.py`). Keep `slug`, `name`, `logo`, `group` in sync. If the channel is genuinely gone, remove it from both lists (the `git add streams/` glob and the worker map drop it automatically) and delete `streams/{slug}.m3u`.

**Fix C — only the raw mirror is stale, Worker serves `live`.** No code bug. A token expired before the next commit landed. It self-heals on the next cron; only act if the cron itself is stalled (Fix D). Tell the user to prefer the Worker URL.

**Fix D — cron stalled / Actions paused.** The raw commit timestamp (Step 1) is old across all channels and `Refresh TVP M3U` shows no recent runs. The workflow self-re-enables, but GitHub still pauses or delays schedules. Trigger a run manually:

```bash
gh workflow run refresh.yml -R travino/tvpi   # or: Actions tab → Refresh TVP M3U → Run workflow
```

**Fix E — Worker globally 500/stale behavior.** Check the latest `Deploy Worker` run; a TypeScript error blocks deploy. Reproduce locally before pushing:

```bash
cd worker && npm install && npx wrangler types && npx tsc --noEmit
```

Editing anything under `worker/**` and pushing to `main` auto-deploys.

### 4. Verify

```bash
# 1) API now yields a src (re-run the Step 2 curl) — expect an https HLS URL.

# 2) Generator picks it up (pure stdlib, no deps):
python3 generate.py
grep -h '^http' streams/tvpsport.m3u   # the fixed channel(s) → a real URL, not a placeholder

# 3) Worker type-checks (if you touched index.ts):
cd worker && npx wrangler types && npx tsc --noEmit && cd ..

# 4) After deploy lands, the channel should resolve LIVE again:
curl -sI https://tvpi.travny.workers.dev/tvpsport.m3u | grep -i x-source
#   → slug now in X-Source-Live (or X-Source-Cache on a warm colo)
```

Fixed = API returns a src, `generate.py` writes a real URL (no "stream unavailable" stub), worker type-checks, and the slug serves from `live`/`cache`.

### 5. Report

Short: which channel, which layer was failing (from the headers), the root cause, and the exact edit (old → new path, or old → new id) in **both** files. Note if a manual cron dispatch or worker redeploy was needed.

## Notes / guardrails

- **Headers first.** Don't edit code until `X-Source-*` says L2 is actually failing. A channel serving from `live`/`cache` that won't play is a downstream problem, not a repo bug.
- **Keep the two channel lists in lockstep.** `index.ts` `CHANNELS` ↔ `generate.py` `TVP_CHANNELS` — same id/slug/name. A fix to one without the other leaves the Worker and mirror disagreeing.
- **Never "fix" by committing a placeholder.** `generate.py` already reuses last-known-good on transient failures (`resolve_url` / `read_existing_url`); a stub is the genuine-dead path, not a remedy.
- **Don't add KV writes to the request path** while editing the Worker — KV is cron-only by design (free-tier write budget). Writing per request can blow the 1k/day cap from a single hot colo.
- **Geo-block is not a repo bug.** TVP HLS segments are PL-geo-locked; from outside Poland the manifest URL resolves fine (`live`) but segments 403. Nothing in this repo fixes that.
- **Editing `generate.py` doesn't refresh the mirror by itself** — only the cron or a `workflow_dispatch` run of `refresh.yml` regenerates `streams/`. Editing `worker/**` triggers `deploy.yml`.
- If the API shape changed so much that nothing maps cleanly, stop and report — a parser rewrite needs sign-off.
