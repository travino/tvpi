# tvpi-status MCP

A remote [MCP](https://modelcontextprotocol.io) server that reports the health of
the [tvpi](https://github.com/travino/tvpi) playlist. Runs as a Cloudflare Worker
on the **free tier** — no KV, R2, or Durable Object bindings, just outbound fetch.

## Why it exists (token economy)

Asking the chat "is tvpi healthy?" used to mean fetching the whole `playlist.m3u`,
probing channels, and parsing it all *in context* — thousands of throwaway tokens.

The tvpi Worker already resolves every channel per request and reports which
fallback layer served it via `X-Source-*` response headers. This server reads
those headers from **one** request and returns a compact verdict. The heavy work
stays at the edge; the model gets ~one line per channel.

## The tool

### `tvpi_status`

| arg | type | default | meaning |
|---|---|---|---|
| `slug` | string | — | one channel (e.g. `tvp1`); omit for all |
| `deep` | boolean | `false` | also follow each `.m3u8` redirect to confirm a fresh tokenized manifest resolves |

Verdicts:

- **ok** — served `live` or from fresh `cache` (TVP token fetch working)
- **degraded** — served from `kv` / `raw` / `r2` (live fetch failing, fallback in use)
- **dead** — a known channel absent from the playlist

`deep` confirms the Worker *resolves* a tokenized manifest URL; it deliberately
does **not** fetch the manifest body — TVP CDN tokens are geo/IP-bound and 403
from outside Poland, so a body fetch would false-fail healthy channels.

Output is human text plus `structuredContent` (the full report object).

## Deploy

```bash
npm install
npx wrangler login      # one-time
npm run deploy
```

Deploys to `https://tvpi-status-mcp.<your-subdomain>.workers.dev`.

## Connect in Claude

Settings → Connectors → Add custom connector → paste the Worker URL. No auth
(read-only, public data). Then ask: *"check tvpi status"* or *"deep-check tvp1"*.

## Local dev

```bash
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
```

## Keeping it correct

`KNOWN_SLUGS` in `src/index.ts` must match tvpi's `CHANNELS` / `TVP_CHANNELS`.
When a channel is added there, add the slug here so a fully-dead channel is still
flagged (extra channels the playlist reports are classified automatically).
