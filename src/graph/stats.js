import { neo4jQuery } from './neo4j.js';
import { jsonResponse } from '../helpers/response.js';

export async function graphStats(url, env) {
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

export async function ingestStatus(url, env) {
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  try {
    const result = await neo4jQuery(env,
      `MATCH (s:Song) WITH count(s) as songCount
       OPTIONAL MATCH (a:Artist) WITH songCount, count(a) as artistCount
       OPTIONAL MATCH ()-[r:BY]->() RETURN songCount, artistCount, count(r) as relationships`);
    const v = result.data?.values?.[0] || [0, 0, 0];
    return jsonResponse({ songs: v[0], artists: v[1], relationships: v[2] });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}
