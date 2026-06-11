---
name: tvpi
description: Work on the travino/tvpi IPTV project — review the Worker/generator/workflows against the project invariants, diagnose and fix a dead or stale channel, or add a new channel (TVP API, direct HLS, YouTube live). Use whenever tvpi comes up at all — "review tvpi", "audit the worker", a channel is offline/dropping/red-badged, "fix the stream", "tvpi is broken", "add TVP X", "put channel Y in the playlist", a vod.tvp.pl live URL or .m3u8 URL is given, or after modifying worker/src/index.ts, generate.py, or the workflows. Read the matching reference file before acting.
license: Complete terms in LICENSE.txt
---

# tvpi (travino/tvpi)

Polish live TV served as M3U playlists through two paths fed off the same channel list:

- **Worker** (`https://tvpi.travny.workers.dev`, `worker/src/index.ts`) — per-request resolution **L1** per-colo Cache → **L2** live TVP API → **L3a** KV last-known-good → **L3b** raw GitHub mirror. KV is written **only** by the cron (`scheduled()`), never on the request path — the free tier allows ~1k KV writes/day.
- **Raw mirror** (`https://raw.githubusercontent.com/travino/tvpi/main/streams/{slug}.m3u`) — static snapshots committed every 15 min by `generate.py` (pure stdlib) via `.github/workflows/refresh.yml`. `deploy.yml` redeploys the Worker on any push to `worker/**`.

TVP signs HLS tokens with a ~15–30 min lifetime, so freshness and fallback are the whole game. The cardinal cross-file rule: **`CHANNELS` (index.ts) and `TVP_CHANNELS` (generate.py) stay identical** — same `slug`, `id`, `name`, `group`.

Current channels: `tvp1` 399697, `tvp2` 399698, `tvpinfo` 399699, `tvpsport` 399702, `tvpdokument` 399721, `tvpnauka` 399722, `tvprozrywka` 399724, `tvphistoria` 399703.

## Working from claude.ai chat

The repo isn't on disk and `gh`/`wrangler` aren't authenticated. Two ways to work:

- **github connector** (`github:get_file_contents`, `github:push_files`) — preferred. Edit `worker/src/index.ts` and `generate.py` together in **one `push_files` commit** so the two stay in lockstep (see the `github-ops` skill).
- **`git clone` in the bash sandbox** when you need to run local checks (`npx wrangler types && npx tsc --noEmit`, `python3 generate.py`). The sandbox has no GitHub auth — clone works only while the repo is **public**. If private, stay connector-only and verify via the Actions run. Never paste a token into chat.

Replace every `gh ...` call with the connector equivalents (`github:list_commits`, workflow reads/dispatch through the connector). After writing, re-read the file (commit SHA) and check the Actions run; report the SHA/run conclusion, not "done."

## Pick the task

| Task | Read |
|---|---|
| Review/audit the repo or a change — KV-write discipline, fallback order, TTLs vs token lifetime, LKG preservation, channel parity, workflows | `references/review.md` |
| A channel is dead/stale/dropping; mirror stale; "fix the stream" — diagnose via `X-Source-*` headers, minimal fix, verify | `references/channel-fix.md` |
| Add a channel — pick source type (TVP API / direct HLS / YouTube live), edit both files, verify | `references/add-channel.md` |

Read the reference fully before editing; the invariants there are load-bearing and enforced nowhere else.
