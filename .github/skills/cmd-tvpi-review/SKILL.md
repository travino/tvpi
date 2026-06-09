---
name: cmd-tvpi-review
description: Review the travino/tvpi IPTV project for correctness and its load-bearing invariants — KV-write discipline in the Worker, the L1→L2→L3a→L3b resolution/fallback order, TTLs kept under TVP's token lifetime, last-known-good preservation in generate.py, channel-list parity between worker/src/index.ts and generate.py, and the refresh/deploy workflows. Use when asked to "review tvpi", "audit the worker", "check the stream generator", or after modifying index.ts, generate.py, or the workflows.
---

# TVP Project Review (travino/tvpi)

> **In claude.ai chat.** The repo isn't checked out on disk here, and `gh`/`wrangler` aren't authenticated. Two ways to work:
> - **Read/write via the github connector** (`github:get_file_contents`, `github:create_or_update_file`, `github:push_files`) — preferred for small, targeted edits. Edit `worker/src/index.ts` and `generate.py` together in one `push_files` call so the two stay in lockstep (see the `github-ops` skill).
> - **Or `git clone` in the bash sandbox** when you need to actually run the local checks below (`npx wrangler types && npx tsc --noEmit`, `python3 generate.py`). The sandbox can run `git`/`npm`/`python3`/`curl` but starts empty and **has no GitHub auth** — so the clone only works while the repo is **public** (`git clone https://github.com/travino/tvpi`). **If the repo is private**, the connector still works fine; just stay connector-only — read files via `github:*`, push, and verify by watching the Actions run instead of running the checks locally. Don't paste a token into the chat to force a clone.
> Replace every `gh ...` call (workflow dispatch, API reads, run logs) with the github connector: `github:list_issues`, `github:list_commits`, `github:get_latest_release`, and dispatch/run-log reads through the connector — `gh` has no token in chat. After writing, verify by re-reading the file (returned commit SHA) and checking the Actions run, then report the SHA/run conclusion, not just "done."


Audit the Worker, the generator, and the workflows for correctness, robustness, and the project's load-bearing invariants. This is the only place the design rules are enforced, so check them explicitly rather than trusting that code "looks fine."

## Instructions

1. **Scope** — the whole repo by default, or a named file (`index.ts`, `generate.py`, a workflow).
2. **Read** `worker/src/index.ts`, `generate.py`, `worker/wrangler.jsonc`, `.github/workflows/refresh.yml`, and `.github/workflows/deploy.yml`.
3. **Evaluate** against the checklists below. Cite `file_path:line_number` for every finding.
4. If clean, say so briefly — don't invent issues.

Context that drives the review: the Worker is the recommended self-healing path and the raw mirror is the backup; both read from the same channel list and must agree. TVP signs HLS tokens with a short (~15–30 min) lifetime, so freshness and fallback are the whole game. The free Cloudflare tier allows ~1k KV writes/day, which is why KV-write placement is the single most important thing to check.

## Worker review (`worker/src/index.ts`)

### KV-write discipline (cardinal rule)

- KV is written **only** from `scheduled()` / `refreshAllStreams`. The request path (`fetch`, `getStreamUrl`, and anything it `await`s or `waitUntil`s) must **never** call `writeToKV`. A per-request KV write can exhaust the free-tier 1k/day cap from a single hot colo. **ERROR** if any request-path code writes KV.
- The request path may write the per-colo **Cache** (`writeToCache` via `ctx.waitUntil`) — that's expected and cheap.

### Resolution & fallback order

- Order is L1 Cache → L2 live TVP API → L3a KV last-known-good → L3b raw GitHub mirror, returning the first hit and tagging `source`.
- A transient L2 failure must **fall through** to KV/raw, not poison the cache or return an error. Cache is written only on a successful live fetch.
- `withRetry`'s contract holds: the fetch fn **throws** on transport failure (so it's retried) and **returns null** on a reachable-but-empty response. A fn that swallows errors into `null` silently defeats retry — **WARN**.
- All sources exhausted → HTTP 503 (not a 200 with an empty/garbage body). Unknown slug → 404 listing available slugs.

### TTLs vs token lifetime

- `CACHE_TTL` is comfortably **below** TVP's ~15–30 min token lifetime (currently 600s). A value ≥ ~900s risks serving an expired token from cache — **WARN**/**ERROR** by margin.
- Two different crons exist — don't conflate them: the **Worker** cron (`wrangler.jsonc`, currently `*/30`) is what **writes KV**; the **GitHub Actions** cron (`refresh.yml`, `*/15`) refreshes the **raw mirror**. `KV_TTL` (currently 900s = 15 min) must be **shorter than the Worker cron** so a stale KV entry expires between cron writes and resolution falls through to the ~15-min-fresh raw mirror instead of serving a dead token. If `KV_TTL` ≥ the Worker cron interval, flag it — **WARN**.

### Robustness

- Every upstream `fetch` is bounded by a timeout (`AbortSignal.timeout(LIVE_TIMEOUT_MS)`); no unbounded awaits on TVP, KV, or GitHub.
- Diagnostic headers present and accurate: `X-Source-Cache/Live/KV/Raw` reflect where each channel was served (this is what `tvpi-channel-fix` reads).
- Playlist responses send `Cache-Control: no-store` (clients must not cache short-lived tokens) and `Access-Control-Allow-Origin: *`.
- Handler is typed (`satisfies ExportedHandler<Env>`) and the file type-checks (`npx wrangler types && npx tsc --noEmit`) — a TS error blocks `deploy.yml`.

## Generator review (`generate.py`)

- **Last-known-good preservation**: a transient TVP failure reuses the channel's previous URL via `resolve_url` / `read_existing_url` and leaves the existing file untouched — it never overwrites a good `streams/<slug>.m3u` with a placeholder. **ERROR** if a fetch failure can clobber a good file.
- A placeholder stub is written **only** when there is neither a fresh nor a cached URL.
- The combined `streams/playlist.m3u` is rebuilt from the available entries each run.
- **Pure standard library** — no third-party imports. `refresh.yml` installs nothing for the generator; any `requests`/`yt-dlp`/etc. import will fail the run. **ERROR** on a non-stdlib import unless the workflow was updated to install it.
- Exit code: non-zero only when **zero** channels are available (a single channel failing is non-fatal).

## Cross-file parity (most common drift)

- The channel set in `CHANNELS` (`index.ts`) and `TVP_CHANNELS` (`generate.py`) is **identical** — same `slug`, `id`, `name`, `group`. A slug in one but not the other means the Worker 404s a channel the mirror serves, or the mirror lacks a channel the Worker serves. **ERROR** on any mismatch; list the differing slugs.
- Any static/direct-HLS channel added to one path exists in the other too (worker `src` short-circuit ↔ generator static emit).

## Workflow review (`.github/workflows/`)

- **refresh.yml**: `*/15` cron + `workflow_dispatch`; a keep-alive step re-enables the schedule (scheduled workflows auto-disable after 60 days of inactivity); a job `timeout-minutes`; commits via `git add streams/` (glob picks up new channels) and `git diff --cached --quiet || git commit` so empty runs don't error.
- **deploy.yml**: triggers on `worker/**` (and its own path); **type-check gate** (`wrangler types` + `tsc --noEmit`) runs before `wrangler deploy`; `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` come from secrets, never hardcoded.
- **wrangler.jsonc**: the KV namespace binding the worker reads as `env.LKG` is declared; a cron trigger is configured (so `scheduled()` actually fires — currently `*/30`) and its interval is longer than `KV_TTL` per the TTL check above. Note this Worker cron is distinct from the `*/15` Actions mirror cron in `refresh.yml`.

## Output

Per finding:

```
[SEVERITY] file_path:line_number — description
```

`ERROR` (broken / will fail / violates a cardinal invariant) · `WARN` (fragile / margin too thin / convention) · `INFO` (suggestion).

End with:

| Area | Status | Note |
|------|--------|------|
| Worker (KV/TTL/fallback) | OK/WARN/ERROR | brief |
| generate.py (LKG/stdlib) | OK/WARN/ERROR | brief |
| Channel parity | OK/ERROR | brief |
| Workflows | OK/WARN/ERROR | brief |
