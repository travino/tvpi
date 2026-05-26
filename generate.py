#!/usr/bin/env python3
"""
TVP + wPolsce24 M3U generator — runs in GitHub Actions
Writes files to the streams/ directory:
  streams/playlist.m3u  ← combined (all channels)
  streams/tvp1.m3u, streams/tvp2.m3u, streams/tvpinfo.m3u,
  streams/tvpkultura.m3u, streams/tvpdokument.m3u, streams/tvpsport.m3u,
  streams/tvpnauka.m3u, streams/tvprozrywka.m3u, streams/tvphistoria.m3u,
  streams/wpolsce24.m3u, streams/republika.m3u
"""

import json
import os
import subprocess
import sys
import urllib.request

STREAMS_DIR = "streams"

# ---------------------------------------------------------------------------
# TVP channels — fetched from the TVP API
# ---------------------------------------------------------------------------

TVP_CHANNELS = [
    {
        "id":    "399697",
        "slug":  "tvp1",
        "name":  "TVP 1 HD",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399698",
        "slug":  "tvp2",
        "name":  "TVP 2 HD",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399699",
        "slug":  "tvpinfo",
        "name":  "TVP Info",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399700",
        "slug":  "tvpkultura",
        "name":  "TVP Kultura",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399702",
        "slug":  "tvpsport",
        "name":  "TVP Sport",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399721",
        "slug":  "tvpdokument",
        "name":  "TVP Dokument",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399722",
        "slug":  "tvpnauka",
        "name":  "TVP Nauka",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399724",
        "slug":  "tvprozrywka",
        "name":  "TVP Rozrywka",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
    {
        "id":    "399703",
        "slug":  "tvphistoria",
        "name":  "TVP Historia",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
]

# ---------------------------------------------------------------------------
# YouTube-sourced channels — fetched via yt-dlp
#
# Use the channel's persistent /live URL (not a fixed video ID): yt-dlp
# resolves it to whatever broadcast is currently live, so a stream restart
# on YouTube's side never breaks the playlist.
# ---------------------------------------------------------------------------

YOUTUBE_CHANNELS = [
    {
        "slug":    "wpolsce24",
        "name":    "wPolsce24",
        "logo":    "https://wpolsce24.tv/favicon.ico",
        "group":   "Polska",
        "yt_url":  "https://www.youtube.com/@TelewizjawPolsce24/live",
    },
    {
        "slug":    "republika",
        "name":    "Telewizja Republika",
        "logo":    "https://tvrepublika.pl/favicon.ico",
        "group":   "Polska",
        "yt_url":  "https://www.youtube.com/@Telewizja_Republika/live",
    },
]

# ---------------------------------------------------------------------------
# TVP API
# ---------------------------------------------------------------------------

TVP_API_URL = (
    "https://vod.tvp.pl/api/products/{id}/videos/playlist"
    "?platform=BROWSER&videoType=LIVE"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://vod.tvp.pl/",
    "Accept": "application/json, */*",
}


def get_tvp_stream_url(channel_id):
    url = TVP_API_URL.format(id=channel_id)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        hls_list = data.get("sources", {}).get("HLS", [])
        if hls_list:
            return hls_list[0]["src"]
    except Exception as e:
        print(f"  [!] {channel_id}: {e}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# yt-dlp helper — extracts the best HLS URL from a YouTube live stream
# ---------------------------------------------------------------------------

def get_youtube_stream_url(yt_url):
    """
    Calls yt-dlp to extract the best HLS manifest URL for a live stream.
    Returns the URL string on success, None on failure.

    yt-dlp must be installed:  pip install yt-dlp
    """
    try:
        result = subprocess.run(
            [
                "yt-dlp",
                "--get-url",
                "-f", "best[protocol=m3u8_native]/best[ext=m3u8]/best",
                "--no-playlist",
                yt_url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        url = result.stdout.strip().splitlines()[0] if result.stdout.strip() else None
        if result.returncode != 0 or not url:
            print(f"  [!] yt-dlp error: {result.stderr.strip()[:200]}", file=sys.stderr)
            return None
        return url
    except FileNotFoundError:
        print("  [!] yt-dlp not found — install with: pip install yt-dlp", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [!] yt-dlp exception: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# M3U helpers
# ---------------------------------------------------------------------------

def extinf(ch):
    # Use tvg-id if present (TVP channels), otherwise use slug
    tvg_id = ch.get("id", ch["slug"])
    return (
        f'#EXTINF:-1 tvg-id="{tvg_id}" '
        f'tvg-name="{ch["name"]}" '
        f'tvg-logo="{ch["logo"]}" '
        f'group-title="{ch["group"]}",{ch["name"]}'
    )


def write_m3u(filename, entries):
    lines = ["#EXTM3U"]
    for ch, url in entries:
        lines.append(f"{extinf(ch)}\n{url}")
    with open(filename, "w", encoding="utf-8") as f:
        f.write("\n\n".join(lines) + "\n")
    print(f"  → {filename}", file=sys.stderr)


def write_placeholder(filename, channel_name):
    with open(filename, "w", encoding="utf-8") as f:
        f.write(f"#EXTM3U\n# {channel_name} stream unavailable — will retry next run\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(STREAMS_DIR, exist_ok=True)
    all_ok_entries = []

    # --- TVP channels ---
    for ch in TVP_CHANNELS:
        print(f"Fetching {ch['name']} (id={ch['id']}) …", file=sys.stderr)
        url = get_tvp_stream_url(ch["id"])

        if url:
            print(f"  ✓ {url[:80]}…", file=sys.stderr)
            all_ok_entries.append((ch, url))
            write_m3u(f"{STREAMS_DIR}/{ch['slug']}.m3u", [(ch, url)])
        else:
            print(f"  ✗ skipped — writing placeholder", file=sys.stderr)
            write_placeholder(f"{STREAMS_DIR}/{ch['slug']}.m3u", ch["name"])

    # --- YouTube-sourced channels ---
    for ch in YOUTUBE_CHANNELS:
        print(f"Fetching {ch['name']} via yt-dlp ({ch['yt_url']}) …", file=sys.stderr)
        url = get_youtube_stream_url(ch["yt_url"])

        if url:
            print(f"  ✓ {url[:80]}…", file=sys.stderr)
            all_ok_entries.append((ch, url))
            write_m3u(f"{STREAMS_DIR}/{ch['slug']}.m3u", [(ch, url)])
        else:
            print(f"  ✗ skipped — writing placeholder", file=sys.stderr)
            write_placeholder(f"{STREAMS_DIR}/{ch['slug']}.m3u", ch["name"])

    # Combined playlist
    write_m3u(f"{STREAMS_DIR}/playlist.m3u", all_ok_entries)

    tvp_ok  = sum(1 for ch, _ in all_ok_entries if ch in TVP_CHANNELS)
    yt_ok   = sum(1 for ch, _ in all_ok_entries if ch in YOUTUBE_CHANNELS)
    total   = len(TVP_CHANNELS) + len(YOUTUBE_CHANNELS)
    print(
        f"\nDone: {tvp_ok}/{len(TVP_CHANNELS)} TVP + {yt_ok}/{len(YOUTUBE_CHANNELS)} YT "
        f"= {len(all_ok_entries)}/{total} streams fetched.",
        file=sys.stderr,
    )
    if len(all_ok_entries) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
