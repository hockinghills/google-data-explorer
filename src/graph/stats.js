import { neo4jQuery } from './neo4j.js';
import { jsonResponse } from '../helpers/response.js';

export async function graphStats(url, env) {
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  try {
    const result = await neo4jQuery(env,
      `OPTIONAL MATCH (a:Activity) WITH count(a) AS activities
       OPTIONAL MATCH (a2:Activity) WHERE a2.embedding IS NOT NULL WITH activities, count(a2) AS embedded
       OPTIONAL MATCH (t:Topic) WITH activities, embedded, count(t) AS topics
       OPTIONAL MATCH (p:Product) WITH activities, embedded, topics, count(p) AS products
       OPTIONAL MATCH ()-[r:THEN]->() WITH activities, embedded, topics, products, count(r) AS chains
       OPTIONAL MATCH ()-[r2:THEN]->() WHERE r2.semanticDistance IS NOT NULL
       WITH activities, embedded, topics, products, chains, count(r2) AS semanticChains
       OPTIONAL MATCH ()-[r3:ABOUT]->()
       RETURN activities, embedded, topics, products, chains, semanticChains, count(r3) AS aboutLinks`
    );
    const v = result.data?.values?.[0] || [0, 0, 0, 0, 0, 0, 0];
    return jsonResponse({
      activities: v[0], embedded: v[1], topics: v[2], products: v[3],
      chains: v[4], semanticChains: v[5], aboutLinks: v[6],
    });
  } catch (e) {
    console.error('Graph stats failed:', e.message);
    return jsonResponse({ error: 'Graph query failed' }, 500);
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
  } catch (e) {
    console.error('Ingest status failed:', e.message);
    return jsonResponse({ error: 'Graph query failed' }, 500);
  }
}

// Lévy flight analysis — returns the semantic step-length distribution
// and the raw flight data for visualization
export async function levyFlights(url, env) {
  const token = url.searchParams.get('token') || url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);

  const resource = url.searchParams.get('resource'); // optional filter
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000'), 10000);

  try {
    // Pull THEN edges with semantic distance, ordered by time
    const matchClause = resource
      ? 'MATCH (a1:Activity)-[r:THEN]->(a2:Activity) WHERE r.semanticDistance IS NOT NULL AND a1.resource = $resource'
      : 'MATCH (a1:Activity)-[r:THEN]->(a2:Activity) WHERE r.semanticDistance IS NOT NULL';

    const result = await neo4jQuery(env,
      `${matchClause}
       RETURN a1.id, a1.title, a1.product, a1.time,
              a2.id, a2.title, a2.product, a2.time,
              r.semanticDistance, r.gap_ms
       ORDER BY a1.time
       LIMIT $limit`,
      { resource: resource || '', limit }
    );

    const rows = result.data?.values || [];
    if (rows.length === 0) {
      return jsonResponse({ flights: [], distribution: null, message: 'No semantic distances computed yet' });
    }

    // Build step-length array
    const steps = rows.map(r => ({
      from: { id: r[0], title: r[1], product: r[2], time: r[3] },
      to: { id: r[4], title: r[5], product: r[6], time: r[7] },
      semanticDistance: r[8],
      gapMs: r[9],
    }));

    const distances = steps.map(s => s.semanticDistance).filter(d => d > 0);
    distances.sort((a, b) => a - b);

    // Distribution analysis for Lévy flight detection
    // Log-binned histogram for log-log plot
    const numBins = 30;
    const minD = distances[0];
    const maxD = distances[distances.length - 1];
    const logMin = Math.log10(Math.max(minD, 0.001));
    const logMax = Math.log10(maxD);
    const logBinWidth = (logMax - logMin) / numBins;

    const bins = [];
    for (let i = 0; i < numBins; i++) {
      const lo = Math.pow(10, logMin + i * logBinWidth);
      const hi = Math.pow(10, logMin + (i + 1) * logBinWidth);
      const count = distances.filter(d => d >= lo && d < hi).length;
      if (count > 0) {
        bins.push({
          midpoint: Math.sqrt(lo * hi), // geometric mean of bin edges
          count,
          density: count / (hi - lo) / distances.length,
        });
      }
    }

    // Basic stats
    const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
    const median = distances[Math.floor(distances.length / 2)];
    const p90 = distances[Math.floor(distances.length * 0.9)];
    const p99 = distances[Math.floor(distances.length * 0.99)];

    // Detect long-range jumps (> 2× median — the "flights")
    const jumpThreshold = median * 2;
    const longJumps = steps.filter(s => s.semanticDistance > jumpThreshold);

    // Simple power-law exponent estimate via log-log linear regression on the tail
    // (distances above median — Clauset et al. recommend fitting only the tail)
    const tail = distances.filter(d => d >= median);
    let alpha = null;
    if (tail.length > 10) {
      // Hill estimator: alpha = 1 + n / sum(ln(x_i / x_min))
      const xmin = tail[0];
      const sumLog = tail.reduce((s, x) => s + Math.log(x / xmin), 0);
      alpha = sumLog > 0 ? 1 + tail.length / sumLog : null;
    }

    return jsonResponse({
      totalSteps: distances.length,
      distribution: {
        bins,
        mean, median, p90, p99,
        min: minD, max: maxD,
        alpha, // Lévy exponent estimate — between 1 and 3 suggests Lévy flight
        isLevy: alpha !== null && alpha > 1 && alpha < 3,
      },
      longJumps: longJumps.slice(0, 50), // biggest semantic leaps for visualization
      flights: steps, // full sequence for rendering
    });
  } catch (e) {
    console.error('Lévy flight analysis failed:', e.message);
    return jsonResponse({ error: 'Flight analysis failed' }, 500);
  }
}
