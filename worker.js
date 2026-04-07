// Google Data Explorer - Cloudflare Worker
// Two-layer architecture:
//   Layer 1: Individual Google APIs for live data (explorer cards)
//   Layer 2: Data Portability API for bulk historical behavioral data (graph ingest)
//
// Environment variables needed:
//   GOOGLE_CLIENT_ID - from Google Cloud Console
//   GOOGLE_CLIENT_SECRET - from Google Cloud Console
//   REDIRECT_URI - your worker URL + /callback
//   PORTABILITY_REDIRECT_URI - your worker URL + /callback/portability
//   NEO4J_URI - neo4j+s://xxx.databases.neo4j.io
//   NEO4J_USERNAME - neo4j
//   NEO4J_PASSWORD - your password
//   NEO4J_DATABASE - neo4j (optional, defaults to neo4j)

// ---- SCOPES ----

// Layer 1: Live API scopes (explorer cards, real-time monitoring)
const LIVE_SCOPES = [
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

// Layer 2: Data Portability scopes (bulk historical export)
// CRITICAL: These CANNOT be mixed with Layer 1 scopes in a single OAuth flow
const PORTABILITY_SCOPES = [
  'https://www.googleapis.com/auth/dataportability.myactivity.youtube',
  'https://www.googleapis.com/auth/dataportability.myactivity.search',
  'https://www.googleapis.com/auth/dataportability.myactivity.maps',
  'https://www.googleapis.com/auth/dataportability.myactivity.shopping',
  'https://www.googleapis.com/auth/dataportability.myactivity.play',
  'https://www.googleapis.com/auth/dataportability.chrome.history',
  'https://www.googleapis.com/auth/dataportability.youtube.subscriptions',
  'https://www.googleapis.com/auth/dataportability.discover.follows',
  'https://www.googleapis.com/auth/dataportability.discover.likes',
  'https://www.googleapis.com/auth/dataportability.saved.collections',
  'https://www.googleapis.com/auth/dataportability.maps.starred_places',
].join(' ');

// Resource groups for portability archive jobs (one job per group for faster processing)
const PORTABILITY_RESOURCES = [
  'myactivity.youtube',
  'myactivity.search',
  'myactivity.maps',
  'myactivity.shopping',
  'myactivity.play',
  'chrome.history',
  'youtube.subscriptions',
  'discover.follows',
  'discover.likes',
  'saved.collections',
  'maps.starred_places',
];

// ---- ROUTER ----

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

    // Graph endpoints
    if (url.pathname === '/ingest/music') return ingestMusic(url, env);
    if (url.pathname === '/ingest/status') return ingestStatus(url, env);
    if (url.pathname === '/graph/stats') return graphStats(url, env);
    if (url.pathname === '/graph/schema') return ensureGraphSchema(url, env);

    return new Response('Not found', { status: 404 });
  }
};

// ---- OAUTH FLOW ----

function redirectToGoogle(env, flow) {
  const isPortability = flow === 'portability';
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: isPortability
      ? (env.PORTABILITY_REDIRECT_URI || env.REDIRECT_URI.replace('/callback', '/callback/portability'))
      : env.REDIRECT_URI,
    response_type: 'code',
    scope: isPortability ? PORTABILITY_SCOPES : LIVE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

async function handleCallback(url, env, flow) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('No code received', { status: 400 });

  const isPortability = flow === 'portability';
  const redirectUri = isPortability
    ? (env.PORTABILITY_REDIRECT_URI || env.REDIRECT_URI.replace('/callback', '/callback/portability'))
    : env.REDIRECT_URI;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    return new Response(`Token error: ${JSON.stringify(tokens)}`, { status: 400 });
  }

  if (isPortability) {
    return Response.redirect(`${url.origin}/explorer?ptoken=${tokens.access_token}`);
  }
  return Response.redirect(`${url.origin}/explorer?token=${tokens.access_token}`);
}

// ---- COMMON HELPERS ----

async function fetchGoogle(endpoint, token, params = {}) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: res.status, message: await res.text() };
  return res.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ---- LAYER 2: DATA PORTABILITY PIPELINE ----

async function initiateArchives(url, env) {
  const token = url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);

  const jobs = [];
  const errors = [];

  for (const resource of PORTABILITY_RESOURCES) {
    try {
      const res = await fetch('https://dataportability.googleapis.com/v1/portabilityArchive:initiate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resources: [resource] }),
      });
      const data = await res.json();
      if (data.archiveJobId) {
        jobs.push({ resource, jobId: data.archiveJobId, accessType: data.accessType || 'unknown' });
      } else {
        errors.push({ resource, error: data.error?.message || data.error || 'unknown' });
      }
    } catch (e) {
      errors.push({ resource, error: e.message });
    }
  }

  return jsonResponse({ jobs, errors, initiated: new Date().toISOString() });
}

async function archiveStatus(url, env) {
  const token = url.searchParams.get('ptoken');
  const jobsParam = url.searchParams.get('jobs');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);
  if (!jobsParam) return jsonResponse({ error: 'No jobs provided' }, 400);

  let jobs;
  try { jobs = JSON.parse(jobsParam); } catch { return jsonResponse({ error: 'Invalid jobs JSON' }, 400); }

  const statuses = [];
  for (const job of jobs) {
    try {
      const res = await fetch(
        `https://dataportability.googleapis.com/v1/archiveJobs/${job.jobId}/portabilityArchiveState`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const data = await res.json();
      statuses.push({ resource: job.resource, jobId: job.jobId, state: data.state || 'UNKNOWN', urls: data.urls || [] });
    } catch (e) {
      statuses.push({ resource: job.resource, jobId: job.jobId, state: 'ERROR', error: e.message });
    }
  }

  const allComplete = statuses.every(s => s.state === 'COMPLETE' || s.state === 'ERROR' || s.state === 'FAILED');
  const readyCount = statuses.filter(s => s.state === 'COMPLETE').length;
  return jsonResponse({ statuses, allComplete, readyCount, total: statuses.length });
}

async function processArchives(url, env) {
  const token = url.searchParams.get('ptoken');
  const resource = url.searchParams.get('resource');
  const archiveUrl = url.searchParams.get('url');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);
  if (!archiveUrl) return jsonResponse({ error: 'No archive URL' }, 400);

  // Fix: Validate archive URL is from Google storage (prevent SSRF/open proxy)
  const ALLOWED_HOSTS = ['storage.googleapis.com', 'storage.cloud.google.com', 'www.googleapis.com'];
  try {
    const parsed = new URL(archiveUrl);
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return jsonResponse({ error: 'Archive URL must be from Google storage' }, 403);
    }
  } catch {
    return jsonResponse({ error: 'Invalid archive URL' }, 400);
  }

  try {
    // Fix: Use ptoken for auth on the archive download
    const res = await fetch(archiveUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return jsonResponse({ error: `Download failed: ${res.status}` }, 500);

    // Fix: Check Content-Length to prevent unbounded memory usage (128MB limit)
    const MAX_SIZE = 128 * 1024 * 1024;
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_SIZE) {
      return jsonResponse({ error: `Archive too large: ${(contentLength / 1024 / 1024).toFixed(0)}MB (max 128MB)` }, 413);
    }

    const contentType = res.headers.get('content-type') || '';
    let activities = [];

    if (contentType.includes('application/json')) {
      const data = await res.json();
      activities = Array.isArray(data) ? data : [data];
    } else if (contentType.includes('text/')) {
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        activities = Array.isArray(data) ? data : [data];
      } catch {
        return jsonResponse({ error: 'Could not parse as JSON', contentType, sample: text.slice(0, 200) }, 422);
      }
    } else {
      // Binary archive - try gzip decompression
      const arrayBuf = await res.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      const isGzip = bytes[0] === 0x1F && bytes[1] === 0x8B;
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;

      if (isGzip) {
        try {
          const ds = new DecompressionStream('gzip');
          const decompressed = new Response(new Blob([bytes]).stream().pipeThrough(ds));
          const text = await decompressed.text();
          const data = JSON.parse(text);
          activities = Array.isArray(data) ? data : [data];
        } catch (e) {
          return jsonResponse({ error: 'Gzip decompression failed', details: e.message }, 422);
        }
      } else if (isZip) {
        return jsonResponse({ needsDecompression: true, format: 'zip', sizeBytes: bytes.length, resource }, 422);
      } else {
        return jsonResponse({
          error: 'Unknown format', contentType,
          magic: Array.from(bytes.slice(0, 4)).map(b => b.toString(16)).join(' '),
          sizeBytes: bytes.length
        }, 422);
      }
    }

    // Flatten nested structures
    if (activities.length === 1 && !activities[0].time && typeof activities[0] === 'object') {
      const inner = Object.values(activities[0]);
      if (Array.isArray(inner[0])) activities = inner[0];
    }

    const result = await ingestActivitiesToGraph(activities, resource, env);
    return jsonResponse({ success: true, resource, activitiesProcessed: activities.length, graphResult: result });
  } catch (e) {
    return jsonResponse({ error: e.message, stack: e.stack }, 500);
  }
}

// ---- GRAPH MODEL ----
// Nodes: Activity, Topic, Hour, Day, Product
// Edges: THEN (sequential), ABOUT (topic), AT (hour), ON (day), USING (product)

async function ensureGraphSchema(url, env) {
  // Fix: require auth — this writes to Neo4j
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  try {
    const indexes = [
      'CREATE INDEX activity_id IF NOT EXISTS FOR (a:Activity) ON (a.id)',
      'CREATE INDEX activity_time IF NOT EXISTS FOR (a:Activity) ON (a.time)',
      'CREATE INDEX activity_resource IF NOT EXISTS FOR (a:Activity) ON (a.resource)',
      'CREATE INDEX topic_name IF NOT EXISTS FOR (t:Topic) ON (t.name)',
      'CREATE INDEX hour_value IF NOT EXISTS FOR (h:Hour) ON (h.value)',
      'CREATE INDEX day_name IF NOT EXISTS FOR (d:Day) ON (d.name)',
      'CREATE INDEX product_name IF NOT EXISTS FOR (p:Product) ON (p.name)',
      'CREATE INDEX song_videoid IF NOT EXISTS FOR (s:Song) ON (s.videoId)',
      'CREATE INDEX artist_name IF NOT EXISTS FOR (a:Artist) ON (a.name)',
    ];
    for (const stmt of indexes) { await neo4jQuery(env, stmt); }
    await neo4jQuery(env, `UNWIND range(0, 23) AS h MERGE (:Hour {value: h})`);
    await neo4jQuery(env,
      `UNWIND ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] AS d MERGE (:Day {name: d})`
    );
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function ingestActivitiesToGraph(activities, resource, env) {
  const nodes = activities.map((a, idx) => {
    const time = a.time ? new Date(a.time) : null;
    return {
      id: `${resource}:${time ? time.getTime() : idx}:${hashCode(a.title || '')}`,
      title: (a.title || '').slice(0, 500),
      titleUrl: a.titleUrl || null,
      header: a.header || resource,
      product: (a.products || []).join(',') || resource.split('.')[0],
      resource,
      time: a.time || null,
      hour: time ? time.getUTCHours() : null,
      dayOfWeek: time ? ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][time.getUTCDay()] : null,
      subtitles: Array.isArray(a.subtitles) ? a.subtitles.map(s => typeof s === 'string' ? s : (s.name || '')).join(' | ') : '',
      description: (a.description || '').slice(0, 500),
      hasLocation: !!(a.locationInfos && a.locationInfos.length > 0),
    };
  }).filter(n => n.time);

  nodes.sort((a, b) => new Date(a.time) - new Date(b.time));
  if (nodes.length === 0) return { nodesCreated: 0, message: 'No timestamped activities' };

  const batchSize = 150;
  let totalCreated = 0;

  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const result = await neo4jQuery(env,
      `UNWIND $nodes AS n
       MERGE (a:Activity {id: n.id})
       SET a.title = n.title, a.titleUrl = n.titleUrl, a.header = n.header,
           a.product = n.product, a.resource = n.resource, a.time = datetime(n.time),
           a.hour = n.hour, a.dayOfWeek = n.dayOfWeek, a.subtitles = n.subtitles,
           a.description = n.description, a.hasLocation = n.hasLocation
       WITH a, n WHERE n.hour IS NOT NULL
       MERGE (h:Hour {value: n.hour}) MERGE (a)-[:AT]->(h)
       WITH a, n WHERE n.dayOfWeek IS NOT NULL
       MERGE (d:Day {name: n.dayOfWeek}) MERGE (a)-[:ON]->(d)
       WITH a, n
       MERGE (p:Product {name: n.product}) MERGE (a)-[:USING]->(p)
       RETURN count(a) as created`,
      { nodes: batch }
    );
    if (result.errors && result.errors.length > 0) {
      return { error: 'Neo4j write failed', details: result.errors, processed: totalCreated };
    }
    totalCreated += batch.length;
  }

  // Build THEN chains
  const chainResult = await neo4jQuery(env,
    `MATCH (a:Activity) WHERE a.resource = $resource
     WITH a ORDER BY a.time
     WITH collect(a) AS acts
     UNWIND range(0, size(acts) - 2) AS i
     WITH acts[i] AS a1, acts[i + 1] AS a2
     MERGE (a1)-[r:THEN]->(a2)
     SET r.gap_ms = duration.between(a1.time, a2.time).milliseconds
     RETURN count(r) AS chains`,
    { resource }
  );

  // Extract topics
  const topicResult = await extractAndLinkTopics(nodes, env);

  return {
    nodesCreated: totalCreated,
    chainsCreated: chainResult.data?.values?.[0]?.[0] || 0,
    topicsLinked: topicResult.linked || 0,
    topicCount: topicResult.topicCount || 0,
  };
}

async function extractAndLinkTopics(nodes, env) {
  const topicMap = new Map();
  const prefixes = [
    'Watched ', 'Searched for ', 'Visited ', 'Viewed ', 'Listened to ',
    'Subscribed to ', 'Installed ', 'Read ', 'Directions to ', 'Used ',
    'Opened ', 'Played ', 'Looked up ', 'Browsed ', 'Liked ',
  ];

  for (const node of nodes) {
    let topic = null;
    const title = node.title || '';
    for (const prefix of prefixes) {
      if (title.startsWith(prefix)) { topic = title.slice(prefix.length); break; }
    }
    if (!topic && title.length > 1 && title.length < 150) topic = title;
    if (topic && topic.length > 1 && topic.length < 200) {
      topic = topic.trim();
      if (!topicMap.has(topic)) topicMap.set(topic, []);
      topicMap.get(topic).push(node.id);
    }
  }

  const topics = Array.from(topicMap.entries()).map(([name, ids]) => ({ name, activityIds: ids }));
  let linked = 0;

  for (let i = 0; i < topics.length; i += 100) {
    const batch = topics.slice(i, i + 100);
    const result = await neo4jQuery(env,
      `UNWIND $topics AS t
       MERGE (topic:Topic {name: t.name})
       WITH topic, t UNWIND t.activityIds AS actId
       MATCH (a:Activity {id: actId})
       MERGE (a)-[:ABOUT]->(topic)
       RETURN count(*) AS linked`,
      { topics: batch }
    );
    linked += result.data?.values?.[0]?.[0] || 0;
  }
  return { linked, topicCount: topics.length };
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  return Math.abs(hash).toString(36);
}

// ---- GRAPH STATS ----

async function graphStats(url, env) {
  // Fix: require auth — this reads from Neo4j
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  try {
    const result = await neo4jQuery(env,
      `OPTIONAL MATCH (a:Activity) WITH count(a) AS activities
       OPTIONAL MATCH (t:Topic) WITH activities, count(t) AS topics
       OPTIONAL MATCH (p:Product) WITH activities, topics, count(p) AS products
       OPTIONAL MATCH ()-[r:THEN]->() WITH activities, topics, products, count(r) AS chains
       OPTIONAL MATCH ()-[r2:ABOUT]->()
       RETURN activities, topics, products, chains, count(r2) AS aboutLinks`
    );
    const v = result.data?.values?.[0] || [0, 0, 0, 0, 0];
    return jsonResponse({ activities: v[0], topics: v[1], products: v[2], chains: v[3], aboutLinks: v[4] });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ---- NEO4J ----

async function neo4jQuery(env, statement, parameters = {}) {
  const host = env.NEO4J_URI.replace('neo4j+s://', '');
  const db = env.NEO4J_DATABASE || 'neo4j';
  const url = `https://${host}/db/${db}/query/v2`;
  const auth = btoa(`${env.NEO4J_USERNAME}:${env.NEO4J_PASSWORD}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement, parameters }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neo4j HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const result = await res.json();
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Neo4j query error: ${JSON.stringify(result.errors[0])}`);
  }
  return result;
}

// ---- LAYER 1: LIVE DATA FETCHERS ----

async function getContacts(token) {
  try {
    const data = await fetchGoogle('https://people.googleapis.com/v1/people/me/connections', token,
      { personFields: 'names,metadata', pageSize: '1', sortOrder: 'LAST_MODIFIED_DESCENDING' });
    return { service: 'Contacts', total: data.totalPeople || data.totalItems || 0,
      latest: data.connections?.[0]?.metadata?.sources?.[0]?.updateTime || null, icon: '\u{1F465}' };
  } catch (e) { return { service: 'Contacts', error: e.message, icon: '\u{1F465}' }; }
}

async function getCalendar(token) {
  try {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 365 * 86400000).toISOString();
    const data = await fetchGoogle('https://www.googleapis.com/calendar/v3/calendars/primary/events', token,
      { timeMin: past, timeMax: now, maxResults: '1', orderBy: 'updated', singleEvents: 'true' });
    const countData = await fetchGoogle('https://www.googleapis.com/calendar/v3/calendars/primary/events', token,
      { timeMin: past, timeMax: now, maxResults: '2500', singleEvents: 'true' });
    return { service: 'Calendar (past year)', total: countData.items?.length || 0,
      latest: data.items?.[0]?.updated || data.items?.[0]?.created || null, icon: '\u{1F4C5}' };
  } catch (e) { return { service: 'Calendar', error: e.message, icon: '\u{1F4C5}' }; }
}

async function getGmail(token) {
  try {
    const profile = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/profile', token);
    const messages = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/messages', token, { maxResults: '1' });
    let latest = null;
    if (messages.messages?.[0]?.id) {
      const msg = await fetchGoogle(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messages.messages[0].id}`,
        token, { format: 'metadata', metadataHeaders: 'Date' });
      latest = msg.payload?.headers?.find(h => h.name === 'Date')?.value || null;
    }
    return { service: 'Gmail', total: profile.messagesTotal || 0, latest, icon: '\u{1F4E7}' };
  } catch (e) { return { service: 'Gmail', error: e.message, icon: '\u{1F4E7}' }; }
}

async function getYouTube(token) {
  try {
    const channels = await fetchGoogle('https://www.googleapis.com/youtube/v3/channels', token, { part: 'statistics', mine: 'true' });
    const stats = channels.items?.[0]?.statistics || {};
    const activities = await fetchGoogle('https://www.googleapis.com/youtube/v3/activities', token, { part: 'snippet', mine: 'true', maxResults: '1' });
    return { service: 'YouTube',
      total: `${stats.viewCount || 0} views, ${stats.subscriberCount || 0} subs, ${stats.videoCount || 0} videos`,
      latest: activities.items?.[0]?.snippet?.publishedAt || null, icon: '\u{1F3AC}' };
  } catch (e) { return { service: 'YouTube', error: e.message, icon: '\u{1F3AC}' }; }
}

async function getYouTubeMusic(token) {
  try {
    const playlists = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlists', token,
      { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
    const likedVideos = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlistItems', token,
      { part: 'snippet,contentDetails', playlistId: 'LL', maxResults: '5' });
    const likedTotal = likedVideos.pageInfo?.totalResults || 0;
    const recentLiked = (likedVideos.items || []).map(item => ({
      title: item.snippet?.title, channel: item.snippet?.videoOwnerChannelTitle, addedAt: item.snippet?.publishedAt }));
    const latest = recentLiked[0]?.addedAt || playlists.items?.[0]?.snippet?.publishedAt || null;
    const preview = recentLiked.slice(0, 3).map(r => `${r.title}${r.channel ? ' \u2014 ' + r.channel : ''}`);
    return { service: 'YouTube Music', total: `${likedTotal} liked, ${playlists.items?.length || 0} playlists`,
      latest, icon: '\u{1F3B5}', detail: preview.length > 0 ? 'recent: ' + preview.join(' | ') : null,
      ingest: '/ingest/music' };
  } catch (e) { return { service: 'YouTube Music', error: e.message, icon: '\u{1F3B5}' }; }
}

async function getFit(token) {
  try {
    const sources = await fetchGoogle('https://www.googleapis.com/fitness/v1/users/me/dataSources', token);
    const total = (sources.dataSource || []).length;
    const sourceTypes = {};
    for (const ds of (sources.dataSource || [])) {
      const t = ds.dataType?.name || 'unknown';
      sourceTypes[t] = (sourceTypes[t] || 0) + 1;
    }
    const now = Date.now(), dayAgo = now - 86400000;
    const aggRes = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }, { dataTypeName: 'com.google.step_count.delta' },
          { dataTypeName: 'com.google.calories.expended' }],
        bucketByTime: { durationMillis: 3600000 }, startTimeMillis: dayAgo, endTimeMillis: now }),
    });
    const aggData = await aggRes.json();
    let latestTs = null, hr = 0, steps = 0, cal = 0, pts = 0;
    for (const b of (aggData.bucket || []).reverse()) {
      for (const ds of (b.dataset || [])) {
        for (const pt of (ds.point || [])) {
          pts++;
          const end = parseInt(pt.endTimeNanos) / 1000000;
          if (!latestTs || end > latestTs) latestTs = end;
          const tn = pt.dataTypeName || ds.dataSourceId || '';
          if (tn.includes('heart_rate')) hr++;
          if (tn.includes('step_count')) steps++;
          if (tn.includes('calories')) cal++;
        }
      }
    }
    const parts = [`${total} sources`];
    if (hr > 0) parts.push(`${hr} HR (24h)`);
    if (steps > 0) parts.push(`${steps} step records (24h)`);
    if (cal > 0) parts.push(`${cal} cal records (24h)`);
    if (pts === 0) parts.push('no data 24h');
    const types = Object.keys(sourceTypes).map(t => t.replace('com.google.', '')).slice(0, 6);
    return { service: 'Google Fit', total: parts.join(', '),
      latest: latestTs ? new Date(latestTs).toISOString() : null, icon: '\u{1F4AA}',
      detail: `types: ${types.join(', ')}` };
  } catch (e) { return { service: 'Google Fit', error: e.message, icon: '\u{1F4AA}' }; }
}

async function getTasks(token) {
  try {
    const lists = await fetchGoogle('https://tasks.googleapis.com/tasks/v1/users/@me/lists', token);
    const totalLists = lists.items?.length || 0;
    let totalTasks = 0, latest = null;
    for (const list of (lists.items || []).slice(0, 5)) {
      const tasks = await fetchGoogle(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks`, token,
        { maxResults: '100', showCompleted: 'true' });
      totalTasks += tasks.items?.length || 0;
      const lt = tasks.items?.[0]?.updated;
      if (lt && (!latest || lt > latest)) latest = lt;
    }
    return { service: 'Tasks', total: `${totalTasks} tasks in ${totalLists} lists`, latest, icon: '\u{2705}' };
  } catch (e) { return { service: 'Tasks', error: e.message, icon: '\u{2705}' }; }
}

async function getDrive(token) {
  try {
    const about = await fetchGoogle('https://www.googleapis.com/drive/v3/about', token, { fields: 'storageQuota,user' });
    const files = await fetchGoogle('https://www.googleapis.com/drive/v3/files', token,
      { pageSize: '1', orderBy: 'modifiedTime desc', fields: 'files(name,modifiedTime)' });
    const usedGB = about.storageQuota ? (parseInt(about.storageQuota.usage) / (1024**3)).toFixed(2) : '?';
    return { service: 'Drive', total: `${usedGB} GB used`, latest: files.files?.[0]?.modifiedTime || null, icon: '\u{1F4C1}' };
  } catch (e) { return { service: 'Drive', error: e.message, icon: '\u{1F4C1}' }; }
}

// ---- LEGACY MUSIC INGEST ----

async function ingestMusic(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return new Response('No token', { status: 401 });
  try {
    let allSongs = [], nextPageToken = null, page = 0;
    do {
      const params = { part: 'snippet,contentDetails', playlistId: 'LL', maxResults: '50' };
      if (nextPageToken) params.pageToken = nextPageToken;
      const data = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlistItems', token, params);
      allSongs = allSongs.concat((data.items || []).map(item => ({
        videoId: item.contentDetails?.videoId || item.id, title: item.snippet?.title || 'Unknown',
        channel: item.snippet?.videoOwnerChannelTitle || 'Unknown', addedAt: item.snippet?.publishedAt || null,
        description: (item.snippet?.description || '').slice(0, 200) })));
      nextPageToken = data.nextPageToken || null; page++;
    } while (nextPageToken && page < 120);
    let created = 0;
    for (let i = 0; i < allSongs.length; i += 200) {
      const batch = allSongs.slice(i, i + 200);
      const result = await neo4jQuery(env,
        `UNWIND $songs AS song MERGE (s:Song {videoId: song.videoId})
         SET s.title = song.title, s.addedAt = song.addedAt, s.description = song.description
         MERGE (a:Artist {name: song.channel}) MERGE (s)-[:BY]->(a) RETURN count(s) as created`,
        { songs: batch });
      if (result.errors?.length > 0) return jsonResponse({ error: 'Neo4j write failed', details: result.errors }, 500);
      created += batch.length;
    }
    return jsonResponse({ success: true, totalSongs: allSongs.length, nodesCreated: created,
      sampleArtists: [...new Set(allSongs.map(s => s.channel))].slice(0, 20) });
  } catch (e) { return jsonResponse({ error: e.message, stack: e.stack }, 500); }
}

async function ingestStatus(url, env) {
  try {
    const result = await neo4jQuery(env,
      `MATCH (s:Song) WITH count(s) as songCount
       OPTIONAL MATCH (a:Artist) WITH songCount, count(a) as artistCount
       OPTIONAL MATCH ()-[r:BY]->() RETURN songCount, artistCount, count(r) as relationships`);
    const v = result.data?.values?.[0] || [0, 0, 0];
    return jsonResponse({ songs: v[0], artists: v[1], relationships: v[2] });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ---- PAGES ----

function loginPage() {
  return new Response(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data Explorer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a; color: #e0e0e0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; }
  .container { text-align: center; padding: 2rem; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
  p { color: #888; margin-bottom: 2rem; font-size: 1.1rem; }
  a.button { display: inline-block; padding: 1rem 2rem; background: #2563eb;
    color: white; text-decoration: none; border-radius: 8px;
    font-size: 1.1rem; transition: background 0.2s; }
  a.button:hover { background: #1d4ed8; }
</style></head><body>
<div class="container">
  <h1>data explorer</h1>
  <p>see what google actually has on you</p>
  <a class="button" href="/login">sign in with google</a>
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function explorerPage(url, env) {
  const token = url.searchParams.get('token');
  const ptoken = url.searchParams.get('ptoken');
  if (!token && !ptoken) return new Response('No token', { status: 401 });

  let cards = [];
  if (token) {
    const results = await Promise.allSettled([
      getContacts(token), getCalendar(token), getGmail(token),
      getYouTube(token), getYouTubeMusic(token), getFit(token),
      getTasks(token), getDrive(token),
    ]);
    cards = results.map(r => r.status === 'fulfilled' ? r.value : { service: 'Unknown', error: r.reason });
  }

  return new Response(renderExplorer(cards, ptoken), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function formatDate(dateStr) {
  if (!dateStr) return 'unknown';
  try {
    const d = new Date(dateStr);
    const ms = Date.now() - d;
    const mins = Math.floor(ms / 60000), hrs = Math.floor(ms / 3600000), days = Math.floor(ms / 86400000);
    if (mins < 60) return `${mins} min ago`;
    if (hrs < 24) return `${hrs} hours ago`;
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  } catch { return dateStr; }
}

function recencyColor(dateStr) {
  if (!dateStr) return '#333';
  try {
    const days = (Date.now() - new Date(dateStr)) / 86400000;
    if (days < 1) return '#22c55e';
    if (days < 7) return '#84cc16';
    if (days < 30) return '#eab308';
    if (days < 90) return '#f97316';
    return '#ef4444';
  } catch { return '#333'; }
}

function renderExplorer(cards, ptoken) {
  const cardHtml = cards.map(card => {
    if (card.error && !card.service) return '';
    const color = recencyColor(card.latest);
    const recency = formatDate(card.latest);
    return `<div class="card" data-service="${card.service}">
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
           ${card.ingest ? `<button class="ingest-btn" onclick="ingest('${card.ingest}', this)">connect to graph</button>` : ''}`}
      <div class="card-status"></div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>your data</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a; color: #e0e0e0; min-height: 100vh; padding: 2rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.3rem; color: #fff; }
  .subtitle { color: #666; margin-bottom: 1rem; font-size: 0.95rem; }
  .deep-import { background: linear-gradient(135deg, #0f0f1a 0%, #1a0f1a 100%);
    border: 1px solid #2a2040; border-radius: 12px; padding: 1.25rem;
    margin-bottom: 1.5rem; max-width: 1000px; }
  .deep-import h2 { font-size: 1.1rem; color: #c4b5fd; margin-bottom: 0.4rem; }
  .deep-import p { font-size: 0.85rem; color: #888; margin-bottom: 1rem; line-height: 1.4; }
  .deep-import-btn { padding: 0.6rem 1.2rem; background: #2d1f5e; border: 1px solid #4c3a8e;
    color: #c4b5fd; border-radius: 8px; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; }
  .deep-import-btn:hover { background: #3d2f6e; border-color: #6c5aae; }
  .deep-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .deep-import-status { margin-top: 0.75rem; font-size: 0.8rem; color: #666; min-height: 1em; }
  .deep-import-progress { margin-top: 0.5rem; display: none; }
  .job-row { display: flex; justify-content: space-between; padding: 0.25rem 0;
    font-size: 0.75rem; border-bottom: 1px solid #1a1a2a; }
  .job-resource { color: #888; }
  .job-state { font-weight: 500; }
  .job-state.complete { color: #22c55e; }
  .job-state.in-progress { color: #eab308; }
  .job-state.failed { color: #ef4444; }
  .graph-status { background: #111; border: 1px solid #222; border-radius: 8px;
    padding: 0.75rem 1rem; margin-bottom: 1.5rem; max-width: 1000px;
    font-size: 0.9rem; color: #888; display: none; align-items: center; gap: 0.75rem; }
  .graph-status.has-data { display: flex; }
  .graph-status .dot { width: 8px; height: 8px; border-radius: 50%; background: #333; flex-shrink: 0; }
  .graph-status.connected .dot { background: #22c55e; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem; max-width: 1000px; }
  .card { background: #141414; border: 1px solid #222; border-radius: 12px;
    padding: 1.25rem; transition: border-color 0.2s; }
  .card:hover { border-color: #444; }
  .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  .icon { font-size: 1.4rem; }
  .service-name { font-weight: 600; font-size: 1.05rem; flex: 1; }
  .recency-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .volume { font-size: 1.3rem; color: #fff; margin-bottom: 0.4rem; }
  .volume.error { color: #ef4444; font-size: 0.85rem; }
  .detail { font-size: 0.8rem; color: #666; margin-bottom: 0.3rem; }
  .recency { font-size: 0.85rem; color: #888; }
  .recency strong { color: #bbb; }
  .ingest-btn { margin-top: 0.75rem; padding: 0.5rem 1rem; background: #1a1a2e;
    border: 1px solid #333; color: #8b8bce; border-radius: 6px;
    cursor: pointer; font-size: 0.85rem; transition: all 0.2s; width: 100%; }
  .ingest-btn:hover { background: #222244; border-color: #555; color: #aaaaee; }
  .ingest-btn.running { background: #1a2e1a; border-color: #2d5a2d; color: #88cc88; cursor: wait; }
  .ingest-btn.done { background: #1a2e1a; border-color: #22c55e; color: #22c55e; }
  .ingest-btn.error { background: #2e1a1a; border-color: #ef4444; color: #ef4444; }
  .card-status { font-size: 0.75rem; color: #666; margin-top: 0.4rem; min-height: 1em; }
  .legend { margin-top: 2rem; display: flex; gap: 1.5rem; font-size: 0.8rem; color: #666; }
  .legend-item { display: flex; align-items: center; gap: 0.3rem; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
</style></head><body>
<h1>your data</h1>
<div class="subtitle">volume and recency across your google account</div>

<div class="deep-import">
  <h2>deep import</h2>
  <p>the cards below show what's happening now. deep import pulls your full behavioral
  history \u2014 every search, every watch, every rabbit hole \u2014 and maps it into a
  graph of how your attention actually works.</p>
  <button class="deep-import-btn" id="deepImportBtn" onclick="startDeepImport()">
    ${ptoken ? 'begin deep import' : 'authorize deep import'}
  </button>
  <div class="deep-import-status" id="deepImportStatus"></div>
  <div class="deep-import-progress" id="deepImportProgress"></div>
</div>

<div class="graph-status" id="graphStatus">
  <span class="dot"></span>
  <span id="graphStatusText">checking graph...</span>
</div>

${cards.length > 0 ? `<div class="grid">${cardHtml}</div>` : ''}

<div class="legend">
  <div class="legend-item"><span class="legend-dot" style="background:#22c55e"></span> today</div>
  <div class="legend-item"><span class="legend-dot" style="background:#84cc16"></span> this week</div>
  <div class="legend-item"><span class="legend-dot" style="background:#eab308"></span> this month</div>
  <div class="legend-item"><span class="legend-dot" style="background:#f97316"></span> this quarter</div>
  <div class="legend-item"><span class="legend-dot" style="background:#ef4444"></span> stale</div>
</div>

<script>
const token = new URLSearchParams(window.location.search).get('token');
const ptoken = new URLSearchParams(window.location.search).get('ptoken');
let archiveJobs = [];

async function checkGraphStatus() {
  try {
    const [g, s] = await Promise.all([
      fetch('/graph/stats?token=' + (token || ptoken)).then(r => r.json()).catch(() => null),
      fetch('/ingest/status').then(r => r.json()).catch(() => null),
    ]);
    const el = document.getElementById('graphStatus');
    const text = document.getElementById('graphStatusText');
    const parts = [];
    if (g?.activities > 0) { parts.push(g.activities+' activities', g.topics+' topics', g.chains+' chains'); }
    if (s?.songs > 0) { parts.push(s.songs+' songs', s.artists+' artists'); }
    if (parts.length > 0) {
      el.classList.add('connected', 'has-data');
      text.textContent = 'graph: ' + parts.join(', ');
    }
  } catch(e) {}
}

async function startDeepImport() {
  const btn = document.getElementById('deepImportBtn');
  const status = document.getElementById('deepImportStatus');
  if (!ptoken) { window.location.href = '/login/portability'; return; }
  btn.disabled = true;
  btn.textContent = 'initiating archives...';
  status.textContent = 'requesting data export from google...';
  try {
    await fetch('/graph/schema?ptoken=' + encodeURIComponent(ptoken));
    const res = await fetch('/portability/initiate?ptoken=' + encodeURIComponent(ptoken));
    const data = await res.json();
    if (data.jobs?.length > 0) {
      archiveJobs = data.jobs;
      btn.textContent = data.jobs.length + ' archives initiated';
      status.textContent = 'waiting for google to prepare your data...';
      renderProgress(data.jobs.map(j => ({ ...j, state: 'IN_PROGRESS' })));
      if (data.errors.length > 0) status.textContent += ' (' + data.errors.length + ' unavailable)';
      pollArchiveStatus();
    } else {
      btn.textContent = 'no archives created';
      status.textContent = JSON.stringify(data.errors || 'unknown');
    }
  } catch(e) { btn.textContent = 'error'; status.textContent = e.message; }
}

async function pollArchiveStatus() {
  const status = document.getElementById('deepImportStatus');
  const btn = document.getElementById('deepImportBtn');
  try {
    const jobsParam = encodeURIComponent(JSON.stringify(archiveJobs));
    const res = await fetch('/portability/status?ptoken=' + encodeURIComponent(ptoken) + '&jobs=' + jobsParam);
    const data = await res.json();
    renderProgress(data.statuses);
    if (data.allComplete) {
      status.textContent = data.readyCount + '/' + data.total + ' ready. ingesting...';
      let processed = 0;
      for (const s of data.statuses) {
        if (s.state === 'COMPLETE' && s.urls?.length > 0) {
          for (const u of s.urls) {
            status.textContent = 'ingesting ' + s.resource + '...';
            try {
              const r = await fetch('/portability/process?ptoken=' + encodeURIComponent(ptoken) +
                '&resource=' + encodeURIComponent(s.resource) + '&url=' + encodeURIComponent(u));
              const d = await r.json();
              if (d.success) processed++;
            } catch(e) { console.error(s.resource, e); }
          }
        }
      }
      btn.textContent = 'complete \u2014 ' + processed + ' sources';
      btn.style.borderColor = '#22c55e'; btn.style.color = '#22c55e';
      status.textContent = 'behavioral graph built.';
      checkGraphStatus();
    } else {
      status.textContent = data.readyCount + '/' + data.total + ' ready. checking in 30s...';
      setTimeout(pollArchiveStatus, 30000);
    }
  } catch(e) { status.textContent = 'error: ' + e.message; setTimeout(pollArchiveStatus, 30000); }
}

function renderProgress(statuses) {
  const el = document.getElementById('deepImportProgress');
  el.style.display = 'block';
  el.innerHTML = statuses.map(s => {
    const c = s.state === 'COMPLETE' ? 'complete' : (s.state === 'FAILED' || s.state === 'ERROR') ? 'failed' : 'in-progress';
    return '<div class="job-row"><span class="job-resource">'+s.resource+'</span><span class="job-state '+c+'">'+s.state.toLowerCase()+'</span></div>';
  }).join('');
}

async function ingest(endpoint, btn) {
  if (btn.classList.contains('running')) return;
  btn.classList.add('running'); btn.textContent = 'connecting...';
  const st = btn.parentElement.querySelector('.card-status');
  st.textContent = 'pulling data...';
  try {
    const res = await fetch(endpoint + '?token=' + token);
    const data = await res.json();
    if (data.success) {
      btn.classList.remove('running'); btn.classList.add('done');
      btn.textContent = 'connected \u2014 ' + data.totalSongs + ' songs';
      st.textContent = data.sampleArtists.slice(0, 5).join(', ') + '...';
      checkGraphStatus();
    } else {
      btn.classList.remove('running'); btn.classList.add('error');
      btn.textContent = 'error'; st.textContent = data.error || 'unknown';
    }
  } catch(e) {
    btn.classList.remove('running'); btn.classList.add('error');
    btn.textContent = 'error'; st.textContent = e.message;
  }
}

checkGraphStatus();
</script></body></html>`;
}
