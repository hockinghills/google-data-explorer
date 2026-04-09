import { neo4jQuery } from './neo4j.js';
import { jsonResponse } from '../helpers/response.js';

export async function graphExport(url, env) {
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000'), 10000);

  try {
    // Get all Activity nodes with their properties
    const nodesResult = await neo4jQuery(env,
      `MATCH (a:Activity)
       RETURN a.id AS id, a.title AS title, a.product AS product,
              a.time AS time, a.hour AS hour, a.dayOfWeek AS day,
              a.resource AS resource, a.subtitles AS subtitles
       ORDER BY a.time DESC
       LIMIT $limit`,
      { limit }
    );

    // Get Topic nodes
    const topicsResult = await neo4jQuery(env,
      `MATCH (t:Topic)<-[:ABOUT]-(a:Activity)
       WITH t, count(a) AS weight
       WHERE weight > 1
       RETURN t.name AS name, weight
       ORDER BY weight DESC
       LIMIT 200`
    );

    // Get Product nodes
    const productsResult = await neo4jQuery(env,
      `MATCH (p:Product)<-[:USING]-(a:Activity)
       WITH p, count(a) AS weight
       RETURN p.name AS name, weight`
    );

    // Get THEN chains with semantic distance
    const chainsResult = await neo4jQuery(env,
      `MATCH (a1:Activity)-[r:THEN]->(a2:Activity)
       RETURN a1.id AS source, a2.id AS target,
              r.gap_ms AS gapMs, r.semanticDistance AS semanticDistance
       LIMIT $limit`,
      { limit }
    );

    // Get ABOUT relationships
    const aboutResult = await neo4jQuery(env,
      `MATCH (a:Activity)-[:ABOUT]->(t:Topic)
       WITH t, count(a) AS weight WHERE weight > 1
       MATCH (a:Activity)-[:ABOUT]->(t)
       RETURN a.id AS source, t.name AS target
       LIMIT $limit`,
      { limit }
    );

    // Build nodes array
    const nodes = [];
    const nodeIds = new Set();

    // Activity nodes
    for (const row of (nodesResult.data?.values || [])) {
      const id = row[0];
      if (!id) continue;
      nodeIds.add(id);
      nodes.push({
        id,
        title: row[1] || '',
        product: row[2] || '',
        time: row[3] || null,
        hour: row[4],
        day: row[5] || '',
        resource: row[6] || '',
        type: 'activity',
        color: productColor(row[2] || ''),
      });
    }

    // Topic nodes (only those connected to multiple activities)
    for (const row of (topicsResult.data?.values || [])) {
      const id = `topic:${row[0]}`;
      if (!row[0]) continue;
      nodeIds.add(id);
      nodes.push({
        id,
        title: row[0],
        weight: row[1],
        type: 'topic',
        color: '#ffffff',
        size: Math.min(8, 2 + Math.sqrt(row[1])),
      });
    }

    // Product nodes
    for (const row of (productsResult.data?.values || [])) {
      const id = `product:${row[0]}`;
      if (!row[0]) continue;
      nodeIds.add(id);
      nodes.push({
        id,
        title: row[0],
        weight: row[1],
        type: 'product',
        color: productColor(row[0]),
        size: Math.min(12, 3 + Math.sqrt(row[1])),
      });
    }

    // Build links array
    const links = [];

    // THEN chains
    for (const row of (chainsResult.data?.values || [])) {
      if (nodeIds.has(row[0]) && nodeIds.has(row[1])) {
        links.push({
          source: row[0],
          target: row[1],
          type: 'then',
          gapMs: row[2],
          semanticDistance: row[3],
        });
      }
    }

    // ABOUT links
    for (const row of (aboutResult.data?.values || [])) {
      const topicId = `topic:${row[1]}`;
      if (nodeIds.has(row[0]) && nodeIds.has(topicId)) {
        links.push({
          source: row[0],
          target: topicId,
          type: 'about',
        });
      }
    }

    return jsonResponse({
      nodes,
      links,
      meta: {
        nodeCount: nodes.length,
        linkCount: links.length,
        activities: nodesResult.data?.values?.length || 0,
        topics: topicsResult.data?.values?.length || 0,
        products: productsResult.data?.values?.length || 0,
      },
    });
  } catch (e) {
    console.error('Graph export failed:', e.message);
    return jsonResponse({ error: 'Graph export failed' }, 500);
  }
}

function productColor(product) {
  const colors = {
    'YouTube': '#ff4444',
    'Calendar': '#4285f4',
    'Gmail': '#ea4335',
    'Drive': '#0f9d58',
    'Tasks': '#fbbc04',
    'Maps': '#34a853',
    'Search': '#4285f4',
    'Chrome': '#fbbc04',
    'Play': '#48b5a0',
    'Shopping': '#ea8600',
    'Fitness': '#ff6d00',
    'Music': '#ff44ff',
  };
  for (const [key, color] of Object.entries(colors)) {
    if (product.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return '#8b8bce';
}
