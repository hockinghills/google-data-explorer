// Google Data Explorer - Cloudflare Worker
// Shows volume and recency for each Google data source
//
// Environment variables needed (set in wrangler.toml or dashboard):
//   GOOGLE_CLIENT_ID - from Google Cloud Console
//   GOOGLE_CLIENT_SECRET - from Google Cloud Console
//   REDIRECT_URI - your worker URL + /callback (e.g. https://your-worker.your-subdomain.workers.dev/callback)

const SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.heart_rate.read',
  'https://www.googleapis.com/auth/fitness.body.read',
  'https://www.googleapis.com/auth/fitness.sleep.read',
  'https://www.googleapis.com/auth/fitness.location.read',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');

// ---- ROUTER ----

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') return loginPage();
    if (url.pathname === '/login') return redirectToGoogle(env);
    if (url.pathname === '/callback') return handleCallback(url, env);
    if (url.pathname === '/explorer') return explorerPage(url, env);
    if (url.pathname === '/ingest/music') return ingestMusic(url, env);
    if (url.pathname === '/ingest/status') return ingestStatus(url, env);

    return new Response('Not found', { status: 404 });
  }
};

// ---- OAUTH FLOW ----

function redirectToGoogle(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('No code received', { status: 400 });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    return new Response(`Token error: ${JSON.stringify(tokens)}`, { status: 400 });
  }

  // Pass token via URL fragment to explorer (short-lived, single session)
  // In production you'd use encrypted cookies or KV storage
  return Response.redirect(`${url.origin}/explorer?token=${tokens.access_token}`);
}

// ---- DATA FETCHERS ----

async function fetchGoogle(endpoint, token, params = {}) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: res.status, message: await res.text() };
  return res.json();
}

async function getContacts(token) {
  try {
    const data = await fetchGoogle(
      'https://people.googleapis.com/v1/people/me/connections',
      token,
      { personFields: 'names,metadata', pageSize: '1', sortOrder: 'LAST_MODIFIED_DESCENDING' }
    );
    const total = data.totalPeople || data.totalItems || 0;
    const latest = data.connections?.[0]?.metadata?.sources?.[0]?.updateTime || null;
    return { service: 'Contacts', total, latest, icon: '\u{1F465}' };
  } catch (e) {
    return { service: 'Contacts', error: e.message, icon: '\u{1F465}' };
  }
}

async function getCalendar(token) {
  try {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const data = await fetchGoogle(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      token,
      { timeMin: past, timeMax: now, maxResults: '1', orderBy: 'updated', singleEvents: 'true' }
    );
    // Get total with a separate call
    const countData = await fetchGoogle(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      token,
      { timeMin: past, timeMax: now, maxResults: '2500', singleEvents: 'true' }
    );
    const total = countData.items?.length || 0;
    const latest = data.items?.[0]?.updated || data.items?.[0]?.created || null;
    return { service: 'Calendar (past year)', total, latest, icon: '\u{1F4C5}' };
  } catch (e) {
    return { service: 'Calendar', error: e.message, icon: '\u{1F4C5}' };
  }
}

async function getGmail(token) {
  try {
    // Get total messages estimate
    const profile = await fetchGoogle(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      token
    );
    // Get most recent message
    const messages = await fetchGoogle(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      token,
      { maxResults: '1' }
    );
    let latest = null;
    if (messages.messages?.[0]?.id) {
      const msg = await fetchGoogle(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messages.messages[0].id}`,
        token,
        { format: 'metadata', metadataHeaders: 'Date' }
      );
      const dateHeader = msg.payload?.headers?.find(h => h.name === 'Date');
      latest = dateHeader?.value || null;
    }
    return { service: 'Gmail', total: profile.messagesTotal || 0, latest, icon: '\u{1F4E7}' };
  } catch (e) {
    return { service: 'Gmail', error: e.message, icon: '\u{1F4E7}' };
  }
}

async function getYouTube(token) {
  try {
    // Get liked videos count as a proxy for engagement
    const channels = await fetchGoogle(
      'https://www.googleapis.com/youtube/v3/channels',
      token,
      { part: 'statistics', mine: 'true' }
    );
    const stats = channels.items?.[0]?.statistics || {};

    // Get most recent activity
    const activities = await fetchGoogle(
      'https://www.googleapis.com/youtube/v3/activities',
      token,
      { part: 'snippet', mine: 'true', maxResults: '1' }
    );
    const latest = activities.items?.[0]?.snippet?.publishedAt || null;

    return {
      service: 'YouTube',
      total: `${stats.viewCount || 0} views, ${stats.subscriberCount || 0} subs, ${stats.videoCount || 0} videos`,
      latest,
      icon: '\u{1F3AC}'
    };
  } catch (e) {
    return { service: 'YouTube', error: e.message, icon: '\u{1F3AC}' };
  }
}

async function getYouTubeMusic(token) {
  try {
    // Get all playlists
    const playlists = await fetchGoogle(
      'https://www.googleapis.com/youtube/v3/playlists',
      token,
      { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' }
    );
    const totalPlaylists = playlists.items?.length || 0;

    // "LL" is the special playlist ID for liked videos (includes liked music)
    const likedVideos = await fetchGoogle(
      'https://www.googleapis.com/youtube/v3/playlistItems',
      token,
      { part: 'snippet,contentDetails', playlistId: 'LL', maxResults: '5' }
    );
    const likedTotal = likedVideos.pageInfo?.totalResults || 0;

    // Get the most recent liked items as preview
    const recentLiked = (likedVideos.items || []).map(item => ({
      title: item.snippet?.title,
      channel: item.snippet?.videoOwnerChannelTitle,
      addedAt: item.snippet?.publishedAt,
    }));

    const latest = recentLiked[0]?.addedAt || playlists.items?.[0]?.snippet?.publishedAt || null;

    // Build preview text from recent items
    const previewLines = recentLiked.slice(0, 3).map(r => 
      `${r.title}${r.channel ? ' — ' + r.channel : ''}`
    );

    return {
      service: 'YouTube Music',
      total: `${likedTotal} liked, ${totalPlaylists} playlists`,
      latest,
      icon: '\u{1F3B5}',
      detail: previewLines.length > 0 ? 'recent: ' + previewLines.join(' | ') : null,
      ingest: '/ingest/music'
    };
  } catch (e) {
    return { service: 'YouTube Music', error: e.message, icon: '\u{1F3B5}' };
  }
}

async function getFit(token) {
  try {
    // List available data sources to see what's streaming
    const sources = await fetchGoogle(
      'https://www.googleapis.com/fitness/v1/users/me/dataSources',
      token
    );
    const dataSourceList = sources.dataSource || [];
    const total = dataSourceList.length;

    // Categorize data sources by type
    const sourceTypes = {};
    for (const ds of dataSourceList) {
      const type = ds.dataType?.name || 'unknown';
      if (!sourceTypes[type]) sourceTypes[type] = 0;
      sourceTypes[type]++;
    }

    // Query actual data points from the last 24 hours for heart rate and steps
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const startNanos = dayAgo * 1000000;
    const endNanos = now * 1000000;

    // Try to get heart rate data points (most granular/recent)
    let latestDatapoint = null;
    let recentPointCount = 0;

    // Query aggregate data for the last 24h
    const aggregateRes = await fetch(
      'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          aggregateBy: [
            { dataTypeName: 'com.google.heart_rate.bpm' },
            { dataTypeName: 'com.google.step_count.delta' },
            { dataTypeName: 'com.google.calories.expended' },
          ],
          bucketByTime: { durationMillis: 3600000 }, // 1 hour buckets
          startTimeMillis: dayAgo,
          endTimeMillis: now,
        }),
      }
    );
    const aggData = await aggregateRes.json();

    // Find the most recent bucket with actual data
    let latestTimestamp = null;
    let heartRatePoints = 0;
    let stepPoints = 0;
    let calPoints = 0;

    for (const bucket of (aggData.bucket || []).reverse()) {
      for (const dataset of (bucket.dataset || [])) {
        for (const point of (dataset.point || [])) {
          recentPointCount++;
          const pointEnd = parseInt(point.endTimeNanos) / 1000000;
          if (!latestTimestamp || pointEnd > latestTimestamp) {
            latestTimestamp = pointEnd;
          }
          const typeName = point.dataTypeName || dataset.dataSourceId || '';
          if (typeName.includes('heart_rate')) heartRatePoints++;
          if (typeName.includes('step_count')) stepPoints++;
          if (typeName.includes('calories')) calPoints++;
        }
      }
    }

    const latest = latestTimestamp ? new Date(latestTimestamp).toISOString() : null;

    // Build a meaningful summary
    const parts = [];
    parts.push(`${total} sources`);
    if (heartRatePoints > 0) parts.push(`${heartRatePoints} HR readings (24h)`);
    if (stepPoints > 0) parts.push(`${stepPoints} step records (24h)`);
    if (calPoints > 0) parts.push(`${calPoints} cal records (24h)`);
    if (recentPointCount === 0) parts.push('no data points in 24h');

    // Also list the data types available
    const typeNames = Object.keys(sourceTypes).map(t => t.replace('com.google.', '')).slice(0, 6);

    return {
      service: 'Google Fit',
      total: parts.join(', '),
      latest,
      icon: '\u{1F4AA}',
      detail: `types: ${typeNames.join(', ')}`
    };
  } catch (e) {
    return { service: 'Google Fit', error: e.message, icon: '\u{1F4AA}' };
  }
}

async function getTasks(token) {
  try {
    const lists = await fetchGoogle(
      'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
      token
    );
    const totalLists = lists.items?.length || 0;

    let totalTasks = 0;
    let latest = null;
    for (const list of (lists.items || []).slice(0, 5)) {
      const tasks = await fetchGoogle(
        `https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks`,
        token,
        { maxResults: '100', showCompleted: 'true' }
      );
      totalTasks += tasks.items?.length || 0;
      const listLatest = tasks.items?.[0]?.updated;
      if (listLatest && (!latest || listLatest > latest)) latest = listLatest;
    }

    return { service: 'Tasks', total: `${totalTasks} tasks in ${totalLists} lists`, latest, icon: '\u{2705}' };
  } catch (e) {
    return { service: 'Tasks', error: e.message, icon: '\u{2705}' };
  }
}

async function getDrive(token) {
  try {
    const about = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/about',
      token,
      { fields: 'storageQuota,user' }
    );

    // Get most recent file
    const files = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files',
      token,
      { pageSize: '1', orderBy: 'modifiedTime desc', fields: 'files(name,modifiedTime)' }
    );

    // Get approximate count
    const countFiles = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files',
      token,
      { pageSize: '1', fields: 'nextPageToken', q: "trashed=false" }
    );

    const latest = files.files?.[0]?.modifiedTime || null;
    const usedGB = about.storageQuota ?
      (parseInt(about.storageQuota.usage) / (1024 * 1024 * 1024)).toFixed(2) : '?';

    return {
      service: 'Drive',
      total: `${usedGB} GB used`,
      latest,
      icon: '\u{1F4C1}'
    };
  } catch (e) {
    return { service: 'Drive', error: e.message, icon: '\u{1F4C1}' };
  }
}

// ---- NEO4J ----

async function neo4jQuery(env, statement, parameters = {}) {
  // Neo4j Aura Query API v2
  const host = env.NEO4J_URI.replace('neo4j+s://', '');
  const db = env.NEO4J_DATABASE || 'neo4j';
  const url = `https://${host}/db/${db}/query/v2`;
  const auth = btoa(`${env.NEO4J_USERNAME}:${env.NEO4J_PASSWORD}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ statement, parameters }),
  });
  return res.json();
}

// ---- MUSIC INGEST ----

async function ingestMusic(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return new Response('No token', { status: 401 });

  try {
    // Fetch liked songs in batches via the LL playlist
    let allSongs = [];
    let nextPageToken = null;
    let page = 0;
    const maxPages = 120;

    do {
      const params = {
        part: 'snippet,contentDetails',
        playlistId: 'LL',
        maxResults: '50',
      };
      if (nextPageToken) params.pageToken = nextPageToken;

      const data = await fetchGoogle(
        'https://www.googleapis.com/youtube/v3/playlistItems',
        token,
        params
      );

      const songs = (data.items || []).map(item => ({
        videoId: item.contentDetails?.videoId || item.id,
        title: item.snippet?.title || 'Unknown',
        channel: item.snippet?.videoOwnerChannelTitle || 'Unknown',
        addedAt: item.snippet?.publishedAt || null,
        description: (item.snippet?.description || '').slice(0, 200),
      }));

      allSongs = allSongs.concat(songs);
      nextPageToken = data.nextPageToken || null;
      page++;
    } while (nextPageToken && page < maxPages);

    // Write to Neo4j using UNWIND in batches of 200
    const batchSize = 200;
    let created = 0;

    for (let i = 0; i < allSongs.length; i += batchSize) {
      const batch = allSongs.slice(i, i + batchSize);

      const result = await neo4jQuery(env,
        `UNWIND $songs AS song
         MERGE (s:Song {videoId: song.videoId})
         SET s.title = song.title,
             s.addedAt = song.addedAt,
             s.description = song.description
         MERGE (a:Artist {name: song.channel})
         MERGE (s)-[:BY]->(a)
         RETURN count(s) as created`,
        { songs: batch }
      );

      if (result.errors && result.errors.length > 0) {
        return new Response(JSON.stringify({
          error: 'Neo4j write failed',
          details: result.errors,
          songsProcessed: created,
          batch: i,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      created += batch.length;
    }

    return new Response(JSON.stringify({
      success: true,
      totalSongs: allSongs.length,
      nodesCreated: created,
      sampleArtists: [...new Set(allSongs.map(s => s.channel))].slice(0, 20),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(JSON.stringify({
      error: e.message,
      stack: e.stack,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function ingestStatus(url, env) {
  try {
    const result = await neo4jQuery(env,
      `MATCH (s:Song)
       WITH count(s) as songCount
       OPTIONAL MATCH (a:Artist)
       WITH songCount, count(a) as artistCount
       OPTIONAL MATCH ()-[r:BY]->()
       RETURN songCount, artistCount, count(r) as relationships`
    );

    const values = result.data?.values?.[0] || [0, 0, 0];
    return new Response(JSON.stringify({
      songs: values[0],
      artists: values[1],
      relationships: values[2],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---- PAGES ----

function loginPage() {
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Data Explorer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
    p { color: #888; margin-bottom: 2rem; font-size: 1.1rem; }
    a.button {
      display: inline-block;
      padding: 1rem 2rem;
      background: #2563eb;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-size: 1.1rem;
      transition: background 0.2s;
    }
    a.button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="container">
    <h1>data explorer</h1>
    <p>see what google actually has on you</p>
    <a class="button" href="/login">sign in with google</a>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function explorerPage(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return new Response('No token', { status: 401 });

  // Fetch all data sources in parallel
  const results = await Promise.allSettled([
    getContacts(token),
    getCalendar(token),
    getGmail(token),
    getYouTube(token),
    getYouTubeMusic(token),
    getFit(token),
    getTasks(token),
    getDrive(token),
  ]);

  const cards = results.map(r => r.status === 'fulfilled' ? r.value : { service: 'Unknown', error: r.reason });

  return new Response(renderExplorer(cards), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function formatDate(dateStr) {
  if (!dateStr) return 'unknown';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  } catch {
    return dateStr;
  }
}

function recencyColor(dateStr) {
  if (!dateStr) return '#333';
  try {
    const diffDays = (Date.now() - new Date(dateStr)) / 86400000;
    if (diffDays < 1) return '#22c55e';     // green - today
    if (diffDays < 7) return '#84cc16';     // lime - this week
    if (diffDays < 30) return '#eab308';    // yellow - this month
    if (diffDays < 90) return '#f97316';    // orange - this quarter
    return '#ef4444';                        // red - stale
  } catch {
    return '#333';
  }
}

function renderExplorer(cards) {
  const cardHtml = cards.map(card => {
    if (card.error && !card.service) return '';
    const color = recencyColor(card.latest);
    const recency = formatDate(card.latest);
    const ingestEndpoint = card.ingest || null;
    return `
      <div class="card" data-service="${card.service}">
        <div class="card-header">
          <span class="icon">${card.icon || '\u{1F4CA}'}</span>
          <span class="service-name">${card.service}</span>
          <span class="recency-dot" style="background:${color}" title="${recency}"></span>
        </div>
        ${card.error
          ? `<div class="volume error">error: ${typeof card.error === 'string' ? card.error : 'unavailable'}</div>`
          : `<div class="volume">${card.total}</div>
             ${card.detail ? `<div class="detail">${card.detail}</div>` : ''}
             <div class="recency">last activity: <strong>${recency}</strong></div>
             ${ingestEndpoint ? `<button class="ingest-btn" onclick="ingest('${ingestEndpoint}', this)" data-endpoint="${ingestEndpoint}">connect to graph</button>` : ''}`
        }
        <div class="card-status"></div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>your data</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    h1 { font-size: 1.8rem; margin-bottom: 0.3rem; color: #fff; }
    .subtitle { color: #666; margin-bottom: 1rem; font-size: 0.95rem; }
    .graph-status {
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
      max-width: 1000px;
      font-size: 0.9rem;
      color: #888;
      display: none;
      align-items: center;
      gap: 0.75rem;
    }
    .graph-status.has-data {
      display: flex;
    }
    .graph-status .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #333;
      flex-shrink: 0;
    }
    .graph-status.connected .dot { background: #22c55e; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
      max-width: 1000px;
    }
    .card {
      background: #141414;
      border: 1px solid #222;
      border-radius: 12px;
      padding: 1.25rem;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: #444; }
    .card-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .icon { font-size: 1.4rem; }
    .service-name { font-weight: 600; font-size: 1.05rem; flex: 1; }
    .recency-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .volume {
      font-size: 1.3rem;
      color: #fff;
      margin-bottom: 0.4rem;
    }
    .volume.error {
      color: #ef4444;
      font-size: 0.85rem;
    }
    .detail {
      font-size: 0.8rem;
      color: #666;
      margin-bottom: 0.3rem;
    }
    .recency {
      font-size: 0.85rem;
      color: #888;
    }
    .recency strong { color: #bbb; }
    .ingest-btn {
      margin-top: 0.75rem;
      padding: 0.5rem 1rem;
      background: #1a1a2e;
      border: 1px solid #333;
      color: #8b8bce;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.2s;
      width: 100%;
    }
    .ingest-btn:hover { background: #222244; border-color: #555; color: #aaaaee; }
    .ingest-btn.running {
      background: #1a2e1a;
      border-color: #2d5a2d;
      color: #88cc88;
      cursor: wait;
    }
    .ingest-btn.done {
      background: #1a2e1a;
      border-color: #22c55e;
      color: #22c55e;
    }
    .ingest-btn.error {
      background: #2e1a1a;
      border-color: #ef4444;
      color: #ef4444;
    }
    .card-status {
      font-size: 0.75rem;
      color: #666;
      margin-top: 0.4rem;
      min-height: 1em;
    }
    .legend {
      margin-top: 2rem;
      display: flex;
      gap: 1.5rem;
      font-size: 0.8rem;
      color: #666;
    }
    .legend-item { display: flex; align-items: center; gap: 0.3rem; }
    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
  </style>
</head>
<body>
  <h1>your data</h1>
  <div class="subtitle">volume and recency across your google account</div>
  <div class="graph-status" id="graphStatus">
    <span class="dot"></span>
    <span id="graphStatusText">checking graph...</span>
  </div>
  <div class="grid">
    ${cardHtml}
  </div>
  <div class="legend">
    <div class="legend-item"><span class="legend-dot" style="background:#22c55e"></span> today</div>
    <div class="legend-item"><span class="legend-dot" style="background:#84cc16"></span> this week</div>
    <div class="legend-item"><span class="legend-dot" style="background:#eab308"></span> this month</div>
    <div class="legend-item"><span class="legend-dot" style="background:#f97316"></span> this quarter</div>
    <div class="legend-item"><span class="legend-dot" style="background:#ef4444"></span> stale</div>
  </div>
  <script>
    const token = new URLSearchParams(window.location.search).get('token');

    async function checkGraphStatus() {
      try {
        const res = await fetch('/ingest/status');
        const data = await res.json();
        const el = document.getElementById('graphStatus');
        const text = document.getElementById('graphStatusText');
        if (data.songs > 0 || data.artists > 0) {
          el.classList.add('connected', 'has-data');
          text.textContent = 'graph: ' + data.songs + ' songs, ' + data.artists + ' artists, ' + data.relationships + ' relationships';
        }
      } catch(e) {
        document.getElementById('graphStatusText').textContent = 'graph: unable to connect';
      }
    }

    async function ingest(endpoint, btn) {
      if (btn.classList.contains('running')) return;
      btn.classList.add('running');
      btn.textContent = 'connecting...';
      const statusEl = btn.parentElement.querySelector('.card-status');
      statusEl.textContent = 'pulling data from api...';

      try {
        const res = await fetch(endpoint + '?token=' + token);
        const data = await res.json();
        if (data.success) {
          btn.classList.remove('running');
          btn.classList.add('done');
          btn.textContent = 'connected — ' + data.totalSongs + ' songs';
          statusEl.textContent = data.sampleArtists.slice(0, 5).join(', ') + '...';
          checkGraphStatus();
        } else {
          btn.classList.remove('running');
          btn.classList.add('error');
          btn.textContent = 'error';
          statusEl.textContent = data.error || 'unknown error';
        }
      } catch(e) {
        btn.classList.remove('running');
        btn.classList.add('error');
        btn.textContent = 'error';
        statusEl.textContent = e.message;
      }
    }

    checkGraphStatus();
  </script>
</body>
</html>`;
}
