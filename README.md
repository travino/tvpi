# TVP Live IPTV — GitHub-hosted M3U

Auto-refreshed TVP live stream playlist, updated every **30 minutes** by GitHub Actions.  
No server required — just point your IPTV player at the raw file URL.

## Player URL

```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/tvp.m3u
```

Replace `YOUR_USERNAME` and `YOUR_REPO` with your actual GitHub username and repo name.

> **Tip:** use the [jsDelivr CDN mirror](https://www.jsdelivr.com/github) for better availability:
> ```
> https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/tvp.m3u
> ```

### ![tvp-vod](https://s.tvp.pl/files/tvp.pl/images/vod-logo-header.png)
- [tvp](https://tvpi.travny.workers.dev/tvp.m3u)
- [tvp1](https://tvpi.travny.workers.dev/tvp1.m3u)
- [tvp2](https://tvpi.travny.workers.dev/tvp2.m3u)
- [tvpinfo](https://tvpi.travny.workers.dev/tvpinfo.m3u)
- [tvpsport](https://tvpi.travny.workers.dev/tvpsport.m3u)
- [tvpdokument](https://tvpi.travny.workers.dev/tvpdokument.m3u)
- [tvpkultura](https://tvpi.travny.workers.dev/tvpkultura.m3u)
- [tvp.m3u](https://raw.githubusercontent.com/travino/tvpi/main/tvp.m3u)
- [tvp1.m3u](https://raw.githubusercontent.com/travino/tvpi/main/tvp1.m3u)
- [tvp2.m3u](https://raw.githubusercontent.com/travino/tvpi/main/tvp2.m3u)
- [tvpsport.m3u](https://raw.githubusercontent.com/travino/tvpi/main/tvpsport.m3u)

## Channels

| Code | Name |
|------|------|
| tvp1hd | TVP 1 HD |
| tvp2hd | TVP 2 HD |

More channels (TVP Info, Kultura, Sport, Polonia, World…) can be enabled by uncommenting lines in `generate.py`.

## How it works

1. **GitHub Actions** runs `generate.py` every 30 minutes (cron schedule).
2. The script calls the TVP Stream API to fetch fresh, signed HLS token URLs.
3. It writes `tvp.m3u` and commits it back to this repo.
4. Your IPTV player fetches the raw file and always gets valid stream URLs.

```
GitHub Actions (every 10 min)
        │
        ▼
  tvpstream.tvp.pl  ──►  signed HLS token URL
        │
        ▼
   tvp.m3u committed to repo
        │
        ▼
  raw.githubusercontent.com/…/tvp.m3u
        │
        ▼
   Your IPTV player 🎬
```

## Setup

1. Fork or push this repo to your GitHub account.
2. Actions run automatically — no secrets or extra config needed.
3. After the first run (up to 30 min), grab the raw URL and add it to your player.

## Tested players

- VLC
- Kodi (PVR IPTV Simple Client)
- TiviMate
- Televizo
- GSE Smart IPTV

## Notes

- Token TTL from TVP is ~15–30 minutes; refreshing every 30 min keeps them valid.
- GitHub Actions scheduled workflows can be delayed by a few minutes during high load.
- GitHub's raw file CDN caches for up to 5 minutes — this is fine for our use case.
- If the Action fails (TVP API down), the previous `tvp.m3u` stays in place unchanged.
