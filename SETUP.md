# Google Data Explorer - Setup

## Architecture

Two-layer data pipeline:
- **Layer 1** (Live APIs): Individual Google service APIs for real-time data cards
- **Layer 2** (Data Portability API): Bulk historical behavioral export → Neo4j graph

These use **separate OAuth flows** because Google requires Data Portability scopes
to be in their own consent flow, not mixed with other API scopes.

## 1. Google Cloud Project

Go to console.cloud.google.com

- Create a new project (or use existing)
- Go to APIs & Services > Library and enable:
  - People API
  - Google Calendar API
  - Gmail API
  - YouTube Data API v3
  - Fitness API
  - Tasks API
  - Google Drive API
  - **Data Portability API** ← new

## 2. OAuth Credentials

Go to APIs & Services > Credentials

- Click Create Credentials > OAuth client ID
- Application type: Web application
- Name: whatever you want
- Authorized redirect URIs — add BOTH:
  - `https://google-data-explorer.your-subdomain.workers.dev/callback`
  - `https://google-data-explorer.your-subdomain.workers.dev/callback/portability`
  - for local testing: `http://localhost:8787/callback` and `http://localhost:8787/callback/portability`
- Save the Client ID and Client Secret

If you haven't configured the OAuth consent screen yet:
- Go to APIs & Services > OAuth consent screen
- User type: External
- Add your email as a test user
- Add scopes for each API above
- **Add Data Portability scopes** (these are restricted/sensitive — see the
  scopes list in worker.js for the full set)

## 3. Neo4j Aura (Graph Database)

- Create a free instance at https://console.neo4j.io
- Save the connection URI, username, and password
- The graph schema is auto-created on first deep import

## 4. Deploy the Worker

```bash
cd google-data-explorer

npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put REDIRECT_URI
# paste: https://google-data-explorer.your-subdomain.workers.dev/callback
npx wrangler secret put PORTABILITY_REDIRECT_URI
# paste: https://google-data-explorer.your-subdomain.workers.dev/callback/portability
npx wrangler secret put NEO4J_URI
npx wrangler secret put NEO4J_USERNAME
npx wrangler secret put NEO4J_PASSWORD

npx wrangler deploy
```

## 5. Test locally (optional)

```bash
cat > .dev.vars << VARS
GOOGLE_CLIENT_ID=your-id-here
GOOGLE_CLIENT_SECRET=your-secret-here
REDIRECT_URI=http://localhost:8787/callback
PORTABILITY_REDIRECT_URI=http://localhost:8787/callback/portability
NEO4J_URI=neo4j+s://xxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
VARS

npx wrangler dev
```

Then open http://localhost:8787 and sign in.

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
  mode, you can use your own account (tokens expire in 7 days).
- Data Portability scopes CANNOT be mixed with regular API scopes in the
  same OAuth flow. The worker handles this with two separate login paths.
- Archive jobs can take minutes to hours depending on data volume.
- The token-in-URL approach is fine for personal prototyping. Production
  would use encrypted cookies or KV-backed sessions.
