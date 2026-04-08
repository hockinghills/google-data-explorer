// Google Data Explorer — Modular Router
// Two-layer architecture:
//   Layer 1: Individual Google APIs for live data (explorer cards)
//   Layer 2: Data Portability API for bulk historical behavioral data (graph ingest)
//
// Environment variables:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI, PORTABILITY_REDIRECT_URI
//   NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE

import { redirectToGoogle, handleCallback } from './auth/oauth.js';
import { loginPage } from './pages/login.js';
import { explorerPage } from './pages/explorer.js';
import { initiateArchives, archiveStatus, processArchives } from './ingest/portability.js';
import { ingestMusic } from './ingest/music.js';
import { discoverTakeout, stageTakeout, processTakeout } from './ingest/takeout.js';
import { graphStats, ingestStatus } from './graph/stats.js';
import { ensureGraphSchema } from './graph/schema.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') return loginPage();
    if (url.pathname === '/explorer') return explorerPage(url, env);

    // Layer 1: Live API OAuth
    if (url.pathname === '/login') return redirectToGoogle(env, 'live');
    if (url.pathname === '/callback') return handleCallback(url, env, 'live');

    // Layer 2: Data Portability OAuth (separate consent flow)
    if (url.pathname === '/login/portability') return redirectToGoogle(env, 'portability');
    if (url.pathname === '/callback/portability') return handleCallback(url, env, 'portability');

    // Layer 2: Portability archive pipeline
    if (url.pathname === '/portability/initiate') return initiateArchives(url, env);
    if (url.pathname === '/portability/status') return archiveStatus(url, env);
    if (url.pathname === '/portability/process') return processArchives(url, env);

    // Takeout pipeline: Drive → R2 → Graph
    if (url.pathname === '/takeout/discover') return discoverTakeout(url, env);
    if (url.pathname === '/takeout/stage') return stageTakeout(url, env);
    if (url.pathname === '/takeout/process') return processTakeout(url, env);

    // Graph endpoints
    if (url.pathname === '/ingest/music') return ingestMusic(url, env);
    if (url.pathname === '/ingest/status') return ingestStatus(url, env);
    if (url.pathname === '/graph/stats') return graphStats(url, env);
    if (url.pathname === '/graph/schema') return ensureGraphSchema(url, env);

    return new Response('Not found', { status: 404 });
  }
};
