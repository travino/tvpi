#!/usr/bin/env python3
"""
TVP M3U generator — runs in GitHub Actions
Writes one combined tvp.m3u AND one file per channel:
  tvp1.m3u, tvp2.m3u, tvpinfo.m3u, tvpkultura.m3u, tvpdokument.m3u, tvpsport.m3u
"""

import json
import sys
import urllib.request

CHANNELS = [
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
        "id":    "399701",
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
]

API_URL = (
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


def get_stream_url(channel_id):
    url = API_URL.format(id=channel_id)
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


def extinf(ch):
    return (
        f'#EXTINF:-1 tvg-id="{ch["id"]}" '
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


def main():
    ok_entries = []

    for ch in CHANNELS:
        print(f"Fetching {ch['name']} (id={ch['id']}) …", file=sys.stderr)
        url = get_stream_url(ch["id"])

        if url:
            print(f"  ✓ {url[:80]}…", file=sys.stderr)
            ok_entries.append((ch, url))
            write_m3u(f"{ch['slug']}.m3u", [(ch, url)])
        else:
            print(f"  ✗ skipped — writing placeholder", file=sys.stderr)
            with open(f"{ch['slug']}.m3u", "w", encoding="utf-8") as f:
                f.write(f"#EXTM3U\n# {ch['name']} stream unavailable — will retry next run\n")

    write_m3u("tvp.m3u", ok_entries)

    print(f"\nDone: {len(ok_entries)}/{len(CHANNELS)} streams fetched.", file=sys.stderr)
    if len(ok_entries) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
        "name":  "TVP Sport",
        "logo":  "https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png",
        "group": "Polska",
    },
]

API_URL = (
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
    "Accept":  "application/json, */*",
}


def get_stream_url(channel_id):
    url = API_URL.format(id=channel_id)
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


def extinf(ch):
    return (
        f'#EXTINF:-1 tvg-id="{ch["id"]}" '
        f'tvg-name="{ch["name"]}" '
        f'tvg-logo="{ch["logo"]}" '
        f'group-title="{ch["group"]}",{ch["name"]}'
    )


def write_m3u(filename, entries):
    """entries = list of (ch, stream_url)"""
    lines = ["#EXTM3U"]
    for ch, url in entries:
        lines.append(f"{extinf(ch)}\n{url}")
    with open(filename, "w", encoding="utf-8") as f:
        f.write("\n\n".join(lines) + "\n")
    print(f"  → {filename}", file=sys.stderr)


def main():
    ok_entries = []   # (ch, url) for the combined file

    for ch in CHANNELS:
        print(f"Fetching {ch['name']} (id={ch['id']}) …", file=sys.stderr)
        url = get_stream_url(ch["id"])

        if url:
            print(f"  ✓ {url[:80]}…", file=sys.stderr)
            ok_entries.append((ch, url))
            # Per-channel file
            write_m3u(f"{ch['slug']}.m3u", [(ch, url)])
        else:
            print(f"  ✗ skipped — writing placeholder", file=sys.stderr)
            # Write a placeholder so the file always exists in the repo
            with open(f"{ch['slug']}.m3u", "w", encoding="utf-8") as f:
                f.write(f"#EXTM3U\n# {ch['name']} stream unavailable — will retry next run\n")

    # Combined file
    write_m3u("tvp.m3u", ok_entries)

    print(f"\nDone: {len(ok_entries)}/{len(CHANNELS)} streams fetched.", file=sys.stderr)
    if len(ok_entries) == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
