# Session State — Google Data Explorer

## What This Project Is

A tool for people with ADHD to see their own digital behavioral data as a beautiful, interactive graph. Not a dashboard. Not a clinical tool. A mirror that shows how a Hunter's mind moves through the world — and makes it look beautiful instead of broken.

The onboarding experience is everything. One card per data silo. One button per card. One bloom per click. The graph builds according to what the person clicks first, second, third — their priority shapes the schema. No help files. No GDPR explanations. No "go deeper" buttons. Simple enough that it doesn't steal the magic.

## Architecture

- Cloudflare Worker at `https://google-data-explorer.empyreanbuilders.workers.dev`
- Neo4j graph database for the behavioral graph
- R2 bucket `data-explorer-archives` for staging takeout ZIPs
- Two data sources: Google Live APIs (real-time) + Google Takeout (historical)
- GitHub repo: `hockinghills/google-data-explorer`, branch `feature/takeout-ingest`

## Takeout Dissection Results

The user's 145 GB takeout dump breaks down as:

| Batch | Size | Contents | Priority |
|-------|------|----------|----------|
| 14 | 272 MB (1 ZIP) | **All activity data** — My Activity HTMLs, Chrome History JSON, Timeline JSON, Fit/Fitbit JSON, Keep, Contacts, Calendar, Tasks | NOW |
| 10 | 7.4 GB (4 ZIPs) | YouTube playlists (CSVs <1MB), uploaded videos, thumbnails | NOW (CSVs only) |
| 12 | 131 GB (65 ZIPs) | Google Photos — all photos/videos | LATER (vision embeddings) |
| 18 | 6.5 GB (4 ZIPs) | Google Drive documents/files | LATER |
| 16 | 839 MB (1 ZIP) | Gmail mbox | LATER |
| 8 | 0.1 MB | Nest thermostat | SKIP |

Key finding: 95% of the weight is photos, videos, and Drive files. All graph-relevant activity data is in ONE 272 MB file (batch 14).

## My Activity HTML Format

Google's Takeout My Activity files are HTML, not JSON. Format per entry:
```html
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="header-cell">Product name (YouTube, Search, etc.)</div>
  <div class="content-cell mdl-cell--6-col mdl-typography--body-1">
    Action <a href="URL">Title</a><br>
    <a href="channel/source URL">Source name</a><br>
    Timestamp in format "Apr 7, 2026, 3:20:10 AM EDT"<br>
  </div>
</div>
```

Actions include: Watched, Liked, Searched for, Visited, etc. Regex-parseable.

YouTube playlists in batch 10 are CSVs with playlist-name-videos.csv naming.

## What's Built

- Takeout pipeline: discover → stage → process (Drive → R2 → Graph)
- Per-user R2 key namespacing (SHA-256 token hash)
- Filename sanitization, POST enforcement for mutations
- ZIP central directory peek via range requests (instant file listing for any size ZIP)
- Single-file sample extraction via range requests
- Timeline normalization shared across all code paths
- All code reviewer comments addressed (3 rounds)

## What's Next

1. **HTML parser** for My Activity files (YouTube, Search, Chrome, etc.)
2. **CSV parser** for YouTube playlists
3. **Setup endpoint** that stages batch 14, cracks it open, sorts pieces into silos
4. **Unified card previews** — merge live API data + takeout data into one preview per card
5. **One button per card** — single action pulls live API + relevant takeout files, ingests to graph
6. **Graph bloom visualization** — the force-directed graph that blooms as cards are added

The vision beyond onboarding: Lévy flight analysis of search history, semantic embeddings via Voyage 4 Large, InfraNodus-style force-directed visualization showing the topology of a person's curiosity. The search history that looks like chaos from inside has the structure of an optimal foraging strategy when seen from above.

## Key Context

- The user has ADHD. The Hunter/Farmer framework (Thom Hartmann) is foundational to this project's philosophy.
- The project exists to show people their minds aren't broken. Self-doubt is the enemy. The data should look beautiful.
- When confused, pause and ask. The user's questions have pathways toward clarity — follow them.
- Rush (the band) resets token trajectory when sessions get diagonal. 
- Harry Miller and Kamauu are philosophical touchstones for this work.

## Credentials

- GitHub token: provided per session (user rolls them)
- Cloudflare token: provided per session
- Google OAuth: user re-auths per session, provides token
- Drive scope upgraded to `drive.readonly` (was metadata-only)

## PR 4 Status

Open on `feature/takeout-ingest`. Three automated reviewers (qodo, codeant, coderabbit). All comments addressed across 3 rounds. Code is pushed and deployed.
