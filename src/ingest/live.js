import { fetchGoogle } from '../helpers/google.js';
import { jsonResponse } from '../helpers/response.js';
import { ingestActivitiesToGraph } from '../graph/ingest.js';
import { neo4jQuery } from '../graph/neo4j.js';

// Ensure graph indexes exist before first ingest
async function ensureIndexes(env) {
  try {
    await neo4jQuery(env, 'CREATE INDEX activity_id IF NOT EXISTS FOR (a:Activity) ON (a.id)');
    await neo4jQuery(env, 'CREATE INDEX activity_time IF NOT EXISTS FOR (a:Activity) ON (a.time)');
    await neo4jQuery(env, 'CREATE INDEX topic_name IF NOT EXISTS FOR (t:Topic) ON (t.name)');
    await neo4jQuery(env, 'CREATE INDEX product_name IF NOT EXISTS FOR (p:Product) ON (p.name)');
    await neo4jQuery(env, `UNWIND range(0, 23) AS h MERGE (:Hour {value: h})`);
    await neo4jQuery(env, `UNWIND ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] AS d MERGE (:Day {name: d})`);
  } catch (e) { console.log('Index setup:', e.message); }
}

// Pull real items from live Google APIs and ingest them as Activity nodes
export async function ingestLive(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'No token' }, 401);

  const results = {};
  const allActivities = [];

  // Ensure graph schema exists
  await ensureIndexes(env);

  // YouTube activities
  try {
    const activities = await fetchGoogle('https://www.googleapis.com/youtube/v3/activities', token,
      { part: 'snippet', mine: 'true', maxResults: '50' });
    const items = (activities.items || []).map(a => ({
      time: a.snippet?.publishedAt,
      title: `Watched ${a.snippet?.title || 'unknown'}`,
      products: ['YouTube'],
      description: a.snippet?.description?.slice(0, 200) || '',
    }));
    allActivities.push(...items);
    results.youtube = items.length;
  } catch (e) { results.youtube = { error: e.message }; }

  // YouTube liked videos
  try {
    const liked = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlistItems', token,
      { part: 'snippet,contentDetails', playlistId: 'LL', maxResults: '50' });
    const items = (liked.items || []).map(item => ({
      time: item.snippet?.publishedAt,
      title: `Liked ${item.snippet?.title || 'unknown'}`,
      titleUrl: `https://youtube.com/watch?v=${item.contentDetails?.videoId}`,
      products: ['YouTube'],
      subtitles: [item.snippet?.videoOwnerChannelTitle || ''],
    }));
    allActivities.push(...items);
    results.liked = items.length;
  } catch (e) { results.liked = { error: e.message }; }

  // YouTube subscriptions
  try {
    const subs = await fetchGoogle('https://www.googleapis.com/youtube/v3/subscriptions', token,
      { part: 'snippet', mine: 'true', maxResults: '50' });
    const items = (subs.items || []).map(s => ({
      time: s.snippet?.publishedAt,
      title: `Subscribed to ${s.snippet?.title || 'unknown'}`,
      products: ['YouTube'],
      description: s.snippet?.description?.slice(0, 200) || '',
    }));
    allActivities.push(...items);
    results.subscriptions = items.length;
  } catch (e) { results.subscriptions = { error: e.message }; }

  // Calendar events
  try {
    const past = new Date(Date.now() - 365 * 86400000).toISOString();
    const now = new Date().toISOString();
    const cal = await fetchGoogle('https://www.googleapis.com/calendar/v3/calendars/primary/events', token,
      { timeMin: past, timeMax: now, maxResults: '250', singleEvents: 'true', orderBy: 'startTime' });
    const items = (cal.items || []).map(evt => ({
      time: evt.start?.dateTime || evt.start?.date,
      title: evt.summary || 'Untitled event',
      products: ['Calendar'],
      description: [
        evt.location,
        evt.attendees ? `${evt.attendees.length} attendees` : null,
      ].filter(Boolean).join(' · '),
    }));
    allActivities.push(...items);
    results.calendar = items.length;
  } catch (e) { results.calendar = { error: e.message }; }

  // Gmail — recent message metadata
  try {
    const list = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/messages', token,
      { maxResults: '100' });
    const msgIds = (list.messages || []).slice(0, 100);
    const items = [];
    // Batch in groups of 10 to avoid hammering the API
    for (let i = 0; i < msgIds.length; i += 10) {
      const batch = msgIds.slice(i, i + 10);
      const msgs = await Promise.all(batch.map(m =>
        fetchGoogle(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, token,
          { format: 'metadata', metadataHeaders: 'Subject,From,Date' }).catch(() => null)
      ));
      for (const msg of msgs) {
        if (!msg) continue;
        const headers = msg.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value;
        if (date) {
          items.push({
            time: new Date(date).toISOString(),
            title: subject || 'No subject',
            products: ['Gmail'],
            subtitles: [from],
            description: (msg.labelIds || []).join(', '),
          });
        }
      }
    }
    allActivities.push(...items);
    results.gmail = items.length;
  } catch (e) { results.gmail = { error: e.message }; }

  // Tasks
  try {
    const lists = await fetchGoogle('https://tasks.googleapis.com/tasks/v1/users/@me/lists', token);
    const items = [];
    for (const list of (lists.items || []).slice(0, 5)) {
      const tasks = await fetchGoogle(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks`, token,
        { maxResults: '100', showCompleted: 'true' });
      for (const t of (tasks.items || [])) {
        if (t.updated) {
          items.push({
            time: t.updated,
            title: `Task: ${t.title || 'Untitled'}`,
            products: ['Tasks'],
            description: [
              t.status === 'completed' ? 'completed' : 'open',
              t.due ? `due ${t.due}` : null,
              list.title,
            ].filter(Boolean).join(' · '),
          });
        }
      }
    }
    allActivities.push(...items);
    results.tasks = items.length;
  } catch (e) { results.tasks = { error: e.message }; }

  // Drive recent files
  try {
    const files = await fetchGoogle('https://www.googleapis.com/drive/v3/files', token,
      { pageSize: '50', orderBy: 'modifiedTime desc',
        fields: 'files(name,mimeType,modifiedTime)', q: 'trashed=false' });
    const items = (files.files || []).map(f => ({
      time: f.modifiedTime,
      title: f.name || 'Untitled',
      products: ['Drive'],
      description: f.mimeType || '',
    }));
    allActivities.push(...items);
    results.drive = items.length;
  } catch (e) { results.drive = { error: e.message }; }

  // Filter out items without valid timestamps
  const valid = allActivities.filter(a => {
    if (!a.time) return false;
    try { new Date(a.time).toISOString(); return true; } catch { return false; }
  });

  if (valid.length === 0) {
    return jsonResponse({ results, total: 0, message: 'No activities with valid timestamps' });
  }

  // Ingest everything into the graph
  const graphResult = await ingestActivitiesToGraph(valid, 'live', env);

  return jsonResponse({
    success: true,
    total: valid.length,
    results,
    graphResult,
  });
}
