import { jsonResponse } from '../helpers/response.js';
import { neo4jQuery } from '../graph/neo4j.js';
import { ingestActivitiesToGraph } from '../graph/ingest.js';
import { PORTABILITY_RESOURCES } from '../auth/scopes.js';

const ALLOWED_CARD_IDS = ['contacts', 'calendar', 'gmail', 'youtube', 'music', 'fitness', 'tasks', 'drive'];

export async function initiateArchives(url, env) {
  const token = url.searchParams.get('ptoken');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);

  // Read and persist selection order — this shapes the graph schema
  let selectionOrder = [];
  try {
    const orderParam = url.searchParams.get('order');
    if (orderParam) {
      const parsed = JSON.parse(orderParam);
      if (Array.isArray(parsed)) {
        selectionOrder = [...new Set(parsed.filter(id => ALLOWED_CARD_IDS.includes(id)))].slice(0, 8);
      }
    }
  } catch { /* invalid JSON, ignore */ }

  // Persist selection order to graph as meta node
  if (selectionOrder.length > 0) {
    try {
      await neo4jQuery(env,
        `MERGE (o:Onboarding {id: 'current'})
         SET o.selectionOrder = $order, o.updatedAt = datetime()`,
        { order: selectionOrder }
      );
    } catch (e) {
      console.error('Failed to persist selection order:', e.message);
    }
  }

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

  return jsonResponse({ jobs, errors, selectionOrder, initiated: new Date().toISOString() });
}

export async function archiveStatus(url, env) {
  const token = url.searchParams.get('ptoken');
  const jobsParam = url.searchParams.get('jobs');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);
  if (!jobsParam) return jsonResponse({ error: 'No jobs provided' }, 400);

  let jobs;
  try { jobs = JSON.parse(jobsParam); } catch { return jsonResponse({ error: 'Invalid jobs JSON' }, 400); }
  if (!Array.isArray(jobs)) return jsonResponse({ error: 'Jobs must be an array' }, 400);

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

export async function processArchives(url, env) {
  const token = url.searchParams.get('ptoken');
  const resource = url.searchParams.get('resource');
  const archiveUrl = url.searchParams.get('url');
  if (!token) return jsonResponse({ error: 'No portability token' }, 401);
  if (!resource) return jsonResponse({ error: 'No resource specified' }, 400);
  if (!archiveUrl) return jsonResponse({ error: 'No archive URL' }, 400);

  // Validate archive URL is from Google storage (prevent SSRF/open proxy)
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
    const res = await fetch(archiveUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return jsonResponse({ error: `Download failed: ${res.status}` }, 500);

    // Check Content-Length to prevent unbounded memory usage (128MB limit)
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
    if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
      const inner = Object.values(activities[0]);
      if (Array.isArray(inner[0])) activities = inner[0];
    }

    const result = await ingestActivitiesToGraph(activities, resource, env);
    return jsonResponse({ success: true, resource, activitiesProcessed: activities.length, graphResult: result });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
