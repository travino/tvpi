/**
 * tvpi-status MCP server — Cloudflare Worker, free tier.
 *
 * A remote MCP server (stateless Streamable HTTP / JSON-RPC 2.0) exposing one
 * tool, `tvpi_status`, that reports the health of the tvpi playlist.
 *
 * Token-saving trick: the tvpi Worker already resolves every channel and
 * reports which fallback layer served it via X-Source-* response headers. This
 * tool reads that one response's headers to build the whole health map — no
 * playlist body parsing in the model's context. `deep` adds a per-channel HLS
 * manifest probe via the stable /<slug>.m3u8 redirect.
 *
 * No KV / R2 / Durable Object bindings — pure outbound fetch, so it stays on
 * the Workers free tier with zero extra cost.
 */

// ---------------------------------------------------------------------------
// Config — keep KNOWN_SLUGS in lockstep with tvpi's CHANNELS / TVP_CHANNELS.
// ---------------------------------------------------------------------------

const WORKER_BASE = "https://tvpi.travny.workers.dev";

const KNOWN_SLUGS = [
  "tvp1", "tvp2", "tvpinfo", "tvpsport",
  "tvpdokument", "tvpnauka", "tvprozrywka", "tvphistoria",
] as const;

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "tvpi-status", version: "1.0.0" };
const FETCH_TIMEOUT_MS = 8_000;
const DEEP_CONCURRENCY = 4;

/** Layers that mean the live TVP token fetch is currently working. */
const HEALTHY_SOURCES = new Set(["live", "cache"]);
/** Layers that mean a stale fallback is in use (upstream degraded). */
const FALLBACK_SOURCES = new Set(["kv", "raw", "r2"]);

type Verdict = "ok" | "degraded" | "dead";
type Source = "cache" | "live" | "kv" | "raw" | "r2" | "unknown";

interface ChannelStatus {
  slug: string;
  source: Source;
  verdict: Verdict;
  /** Present only when deep=true. */
  probe?: { ok: boolean; manifestSource?: string; detail: string };
}

interface StatusReport {
  base: string;
  checkedAt: string;
  deep: boolean;
  summary: { total: number; ok: number; degraded: number; dead: number };
  channels: ChannelStatus[];
}

// ---------------------------------------------------------------------------
// Status logic
// ---------------------------------------------------------------------------

const timeout = (ms: number) => AbortSignal.timeout(ms);

/** slug -> source, parsed from the comma-separated X-Source-* headers. */
function parseSourceHeaders(headers: Headers): Map<string, Source> {
  const map = new Map<string, Source>();
  const layers: Source[] = ["cache", "live", "kv", "raw", "r2"];
  for (const layer of layers) {
    const raw = headers.get(`X-Source-${layer[0].toUpperCase()}${layer.slice(1)}`);
    if (!raw || raw === "none") continue;
    for (const slug of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      map.set(slug, layer);
    }
  }
  return map;
}

function verdictFor(source: Source): Verdict {
  if (HEALTHY_SOURCES.has(source)) return "ok";
  if (FALLBACK_SOURCES.has(source)) return "degraded";
  return "dead";
}

/**
 * Deep probe: follow /<slug>.m3u8 (302) and confirm the Worker resolved a
 * fresh tokenized manifest URL. We do NOT fetch the manifest body: TVP's CDN
 * tokens are geo/IP-bound, so a manifest GET from Cloudflare's edge 403s even
 * for a perfectly healthy channel — a false negative. A successful 302 with a
 * Location proves end-to-end resolution, which is the reliable signal.
 */
async function probeChannel(slug: string): Promise<ChannelStatus["probe"]> {
  try {
    const redirect = await fetch(`${WORKER_BASE}/${slug}.m3u8`, {
      method: "GET",
      redirect: "manual",
      signal: timeout(FETCH_TIMEOUT_MS),
    });
    const manifestSource = redirect.headers.get("X-Source") ?? undefined;
    const location = redirect.headers.get("Location");
    if (redirect.status !== 302 || !location) {
      return { ok: false, manifestSource, detail: `no redirect (status ${redirect.status})` };
    }
    let host = location;
    try {
      host = new URL(location).host;
    } catch {
      /* keep raw */
    }
    return { ok: true, manifestSource, detail: `resolved -> ${host}` };
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, detail: err };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function tvpiStatus(args: { slug?: string; deep?: boolean }): Promise<StatusReport> {
  const deep = args.deep ?? false;
  const single = args.slug?.trim();
  const expected = single ? [single] : [...KNOWN_SLUGS];
  const path = single ? `/${single}.m3u` : "/playlist.m3u";

  const res = await fetch(`${WORKER_BASE}${path}`, { signal: timeout(FETCH_TIMEOUT_MS) });
  const sources = res.ok ? parseSourceHeaders(res.headers) : new Map<string, Source>();

  // Universe = expected channels ∪ any extra slugs the playlist reported.
  const slugs = Array.from(new Set([...expected, ...sources.keys()])).sort();

  let channels: ChannelStatus[] = slugs.map((slug) => {
    const source = sources.get(slug) ?? "unknown";
    return { slug, source, verdict: verdictFor(source) };
  });

  if (deep) {
    const liveSlugs = channels.filter((c) => c.verdict !== "dead").map((c) => c.slug);
    const probes = await mapWithConcurrency(liveSlugs, DEEP_CONCURRENCY, probeChannel);
    const byslug = new Map(liveSlugs.map((s, i) => [s, probes[i]]));
    channels = channels.map((c) => (byslug.has(c.slug) ? { ...c, probe: byslug.get(c.slug) } : c));
  }

  const count = (v: Verdict) => channels.filter((c) => c.verdict === v).length;
  return {
    base: WORKER_BASE,
    checkedAt: new Date().toISOString(),
    deep,
    summary: { total: channels.length, ok: count("ok"), degraded: count("degraded"), dead: count("dead") },
    channels,
  };
}

function renderText(r: StatusReport): string {
  const icon = (v: Verdict) => (v === "ok" ? "OK " : v === "degraded" ? "DEG" : "DEAD");
  const lines = r.channels.map((c) => {
    const probe = c.probe ? `  probe=${c.probe.ok ? "pass" : "FAIL"} (${c.probe.detail})` : "";
    return `  [${icon(c.verdict)}] ${c.slug.padEnd(12)} via ${c.source}${probe}`;
  });
  const s = r.summary;
  return [
    `tvpi status — ${s.ok}/${s.total} ok, ${s.degraded} degraded, ${s.dead} dead  (${r.checkedAt})`,
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "tvpi_status",
    description:
      "Health of the tvpi IPTV playlist. Reads the tvpi Worker's X-Source-* " +
      "headers in one request to classify each channel: ok (served live or " +
      "from fresh cache), degraded (serving a KV/raw/R2 fallback because the " +
      "live TVP token fetch is failing), or dead (channel absent from the " +
      "playlist). Set deep=true to also follow each channel's .m3u8 redirect " +
      "and confirm the Worker resolved a fresh tokenized manifest URL (it does " +
      "not fetch the manifest body, which is geo/token-gated). Pass slug to " +
      "check one channel.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Single channel slug, e.g. 'tvp1'. Omit to check all channels.",
        },
        deep: {
          type: "boolean",
          description: "Also verify each channel resolves a fresh tokenized manifest via its .m3u8 redirect. Default false.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stateless Streamable HTTP
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

async function handleRpc(req: RpcRequest): Promise<object | null> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    // Notifications (no id) — acknowledge with no response body.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(req.id, {});

    case "tools/list":
      return ok(req.id, { tools: TOOLS });

    case "tools/call": {
      const name = (req.params?.name as string) ?? "";
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      if (name !== "tvpi_status") return err(req.id, -32602, `Unknown tool: ${name}`);
      try {
        const report = await tvpiStatus({ slug: args.slug as string, deep: args.deep as boolean });
        return ok(req.id, {
          content: [{ type: "text", text: renderText(report) }],
          structuredContent: report,
          isError: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return ok(req.id, {
          content: [{ type: "text", text: `tvpi_status failed: ${msg}` }],
          isError: true,
        });
      }
    }

    default:
      return err(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
        },
      });
    }

    // Stateless server: no SSE stream to open on GET.
    if (request.method === "GET") {
      return new Response("tvpi-status MCP server. POST JSON-RPC to this endpoint.\n", {
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed.\n", { status: 405, headers: JSON_HEADERS });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify(err(null, -32700, "Parse error")), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }

    // Single request or batch.
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((p) => handleRpc(p as RpcRequest)))).filter(
        (r): r is object => r !== null,
      );
      return new Response(responses.length ? JSON.stringify(responses) : "", {
        status: responses.length ? 200 : 202,
        headers: JSON_HEADERS,
      });
    }

    const response = await handleRpc(payload as RpcRequest);
    return new Response(response ? JSON.stringify(response) : "", {
      status: response ? 200 : 202,
      headers: JSON_HEADERS,
    });
  },
} satisfies ExportedHandler;
