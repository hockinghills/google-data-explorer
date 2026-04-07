# Google Data Explorer - Setup

## Architecture

Two-layer data pipeline:
- **Layer 1** (Live APIs): Individual Google service APIs for real-time data cards
- **Layer 2** (Data Portability API): Bulk historical behavioral export → Neo4j graph

These use **separate OAuth flows** because Google requires Data Portability scopes
to be in their own consent flow, not mixed with other API scopes.

## Deployment

Worker: `https://google-data-explorer.empyreanbuilders.workers.dev`

Secrets (already configured via Cloudflare API):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `REDIRECT_URI` = `https://google-data-explorer.empyreanbuilders.workers.dev/callback`
- `PORTABILITY_REDIRECT_URI` = `https://google-data-explorer.empyreanbuilders.workers.dev/callback/portability`
- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`
- `NEO4J_DATABASE`

## Google Cloud Project

APIs enabled:
- People API, Calendar API, Gmail API, YouTube Data API v3,
  Fitness API, Tasks API, Drive API
- **Data Portability API** (for deep import)

OAuth consent screen must include Data Portability scopes (restricted/sensitive).
Both redirect URIs must be registered in the OAuth client:
- `.../callback`
- `.../callback/portability`

## Graph Model

After deep import, Neo4j contains:

**Nodes:**
- `Activity` — every timestamped action (watch, search, visit, install)
- `Topic` — extracted subjects from activity titles
- `Hour` — 0-23, your circadian fingerprint
- `Day` — Sunday-Saturday
- `Product` — YouTube, Search, Maps, etc.
- `Song` — from YouTube Music ingest
- `Artist` — from YouTube Music ingest

**Relationships:**
- `(Activity)-[:THEN {gap_ms}]->(Activity)` — sequential attention chain
- `(Activity)-[:ABOUT]->(Topic)` — what pulled your attention
- `(Activity)-[:AT]->(Hour)` — when your brain was doing it
- `(Activity)-[:ON]->(Day)` — day-of-week patterns
- `(Activity)-[:USING]->(Product)` — which service
- `(Song)-[:BY]->(Artist)` — music graph

## Notes

- Data Portability API requires app verification for production. In testing
  mode, tokens expire in 7 days.
- Data Portability scopes CANNOT be mixed with regular API scopes in the
  same OAuth flow. The worker handles this with two separate login paths.
- Archive jobs can take minutes to hours depending on data volume.
- The token-in-URL approach is fine for personal prototyping. Production
  would use encrypted cookies or KV-backed sessions.
