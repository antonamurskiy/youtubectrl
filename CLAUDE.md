# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

YouTubeCtrl — a local web app to browse/search YouTube on your phone and play videos on your computer via mpv. Single-user, runs on the local network.

## Commands

```bash
npm start          # Start server on port 3000
npm install        # Install dependencies
pkill -x mpv       # Kill all mpv instances
```

## Architecture

**Single server (`server.js`) + single-page frontend (`public/index.html`), no build step.**

### Content Sources (three-tier fallback to minimize API quota)

| Endpoint | Primary (free) | Fallback (costs quota) |
|---|---|---|
| `/api/search` | youtube-sr scraper | YouTube Data API search (100 units!) |
| `/api/trending` | youtube-sr search | YouTube Data API mostPopular (1 unit) |
| `/api/home` | yt-dlp scraper | YouTube Data API mostPopular (1 unit) |
| `/api/history` | YouTube internal browse API | Local `.history.json` |

YouTube Data API quota is 10,000 units/day. Search costs 100 units per call. Always prefer youtube-sr for search.

### OAuth

- Scope: `youtube.force-ssl` (needed for internal browse API history access)
- Tokens persisted in `.tokens.json`, auto-refreshed when expiring
- OAuth client shared with the `/dev/hk` project (Nest integration)
- Redirect URI: `http://localhost:3000/oauth/callback`

### mpv Playback

- Spawned with `--input-ipc-server=/tmp/mpv-socket` for IPC control
- Unix domain socket sends JSON commands: `{"command": ["get_property", "time-pos"]}`
- mpv keeps the socket open — read first complete JSON line with `request_id`, then close
- Previous mpv killed via `pkill -x mpv` before spawning new one
- Playback position saved every 10s to `.history.json`, resumes on replay

### AeroSpace Integration

- `aerospace workspace 1` focuses LG UltraFine monitor before spawning mpv
- Monitor 1 (Built-in) = workspace 8, Monitor 2 (LG) = workspace 1
- Two fullscreen modes: aerospace fullscreen (keeps dock) vs mpv native fullscreen
- When switching modes, exit the other mode first to avoid conflicts
- Find mpv window ID: `aerospace list-windows --all | grep mpv | awk -F'|' '{print $1}'`

### Frontend

- Vanilla JS, no framework. All in `public/index.html`
- Mobile-first (480px max-width), dark theme with gold accent
- Fonts: Outfit (headings), DM Sans (body) from Google Fonts
- Now-playing bar: fixed bottom, polls `/api/playback` every 1s
- `isSeeking` flag prevents poll from overwriting user's drag position
- `touch-action: manipulation` on `*` to prevent double-tap zoom
- YouTube URL pasted in search box auto-plays immediately

### Caching

- Home feed: 15 min TTL
- Trending: 30 min TTL
- Both caches serve stale data as fallback when API fails

## Key Files

- `.env` — `YOUTUBE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `.tokens.json` — OAuth tokens (runtime, gitignored)
- `.history.json` — Watch history with position/duration (runtime, gitignored)
- `/tmp/mpv-socket` — mpv IPC socket (runtime)
