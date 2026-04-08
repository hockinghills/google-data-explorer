import { fetchGoogle } from '../helpers/google.js';
import { jsonResponse } from '../helpers/response.js';
import { neo4jQuery } from '../graph/neo4j.js';

export async function ingestMusic(url, env) {
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
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}
