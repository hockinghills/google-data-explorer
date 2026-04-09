import { neo4jQuery } from './neo4j.js';
import { jsonResponse } from '../helpers/response.js';

export async function ensureGraphSchema(url, env) {
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

    // Vector index for semantic search and visualization clustering
    try {
      await neo4jQuery(env,
        `CREATE VECTOR INDEX activity_embedding IF NOT EXISTS
         FOR (a:Activity) ON (a.embedding)
         OPTIONS {indexConfig: {\`vector.dimensions\`: 2048, \`vector.similarity_function\`: 'cosine'}}`
      );
    } catch (e) {
      // Vector indexes require Neo4j 5.11+ — non-fatal if unavailable
      console.log('Vector index creation skipped:', e.message);
    }
    await neo4jQuery(env, `UNWIND range(0, 23) AS h MERGE (:Hour {value: h})`);
    await neo4jQuery(env,
      `UNWIND ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] AS d MERGE (:Day {name: d})`
    );
    return jsonResponse({ success: true });
  } catch (e) {
    console.error('Schema setup failed:', e.message);
    return jsonResponse({ error: 'Schema setup failed' }, 500);
  }
}
