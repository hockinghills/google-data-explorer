import { neo4jQuery } from './neo4j.js';
import { hashCode } from '../helpers/format.js';

// Nodes: Activity, Topic, Hour, Day, Product
// Edges: THEN (sequential), ABOUT (topic), AT (hour), ON (day), USING (product)

export async function ingestActivitiesToGraph(activities, resource, env) {
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
     SET r.gap_ms = a2.time.epochMillis - a1.time.epochMillis
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

export async function extractAndLinkTopics(nodes, env) {
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
